import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const DEFAULT_TIMEOUT_MS = 8_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const MAX_URL_LENGTH = 2_048;
const MAX_BYTES = 65_536;
const TITLE_OR_HEAD = /<\/title>|<\/head>/i;

const blockedIps = new BlockList();
blockedIps.addSubnet("0.0.0.0", 8, "ipv4");
blockedIps.addSubnet("10.0.0.0", 8, "ipv4");
blockedIps.addSubnet("100.64.0.0", 10, "ipv4");
blockedIps.addSubnet("127.0.0.0", 8, "ipv4");
blockedIps.addSubnet("169.254.0.0", 16, "ipv4");
blockedIps.addSubnet("172.16.0.0", 12, "ipv4");
blockedIps.addSubnet("192.168.0.0", 16, "ipv4");
blockedIps.addAddress("::", "ipv6");
blockedIps.addAddress("::1", "ipv6");
blockedIps.addSubnet("fc00::", 7, "ipv6");
blockedIps.addSubnet("fe80::", 10, "ipv6");

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export const fetchPageTitleInput = z.object({
  url: z.string().min(1).describe("Absolute http or https URL."),
  timeoutMs: z
    .number()
    .int()
    .min(MIN_TIMEOUT_MS)
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe(`Abort the request after this many milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}.`),
});

export interface PageTitle {
  url: string;
  status: number;
  title: string | null;
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

export interface FetchPageTitleOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  lookupImpl?: (hostname: string) => Promise<ResolvedAddress[]>;
}

export class PageFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PageFetchError";
  }
}

export function extractTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const raw = match?.[1];
  if (raw === undefined) return null;
  const title = decodeHtml(raw.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
  return title.length > 0 ? title : null;
}

export async function fetchPageTitle(rawUrl: string, options: FetchPageTitleOptions = {}): Promise<PageTitle> {
  const timeoutMs = resolveTimeout(options.timeoutMs);
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await loadTitle(rawUrl, {
      fetchImpl: options.fetchImpl ?? fetch,
      lookupImpl: options.lookupImpl ?? defaultLookup,
      signal,
    });
  } catch (error) {
    throw asPageError(error, timeoutMs);
  }
}

export function registerFetchPageTitle(server: McpServer): void {
  server.registerTool(
    "fetch_page_title",
    {
      title: "Fetch page title",
      description:
        "Fetch an http or https URL and return its document title, final URL, and status code. Loopback, link-local, and private hosts are rejected, including names that resolve to those addresses. Redirects are checked the same way. The request times out, and reading stops after the title or 64 KiB.",
      inputSchema: fetchPageTitleInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ url, timeoutMs }) => {
      try {
        const result = await fetchPageTitle(url, timeoutMs === undefined ? {} : { timeoutMs });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const message = error instanceof PageFetchError ? error.message : "Could not fetch the page title.";
        return { content: [{ type: "text", text: message }], isError: true };
      }
    },
  );
}

async function loadTitle(
  rawUrl: string,
  deps: { fetchImpl: typeof fetch; lookupImpl: (hostname: string) => Promise<ResolvedAddress[]>; signal: AbortSignal },
): Promise<PageTitle> {
  let current = parsePublicUrl(rawUrl);

  for (let hop = 0; ; hop += 1) {
    await assertAllowed(current, deps.lookupImpl, deps.signal);
    const response = await deps.fetchImpl(current, {
      redirect: "manual",
      signal: deps.signal,
      headers: {
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
        "user-agent": "mcp-server-demo/1.0",
      },
    });

    if (isRedirect(response.status)) {
      const location = response.headers.get("location");
      await discard(response);
      if (!location) throw new PageFetchError(`Redirect ${response.status} did not include a Location header.`);
      if (hop === MAX_REDIRECTS) throw new PageFetchError("Too many redirects.");
      current = parsePublicUrl(new URL(location, current).href);
      continue;
    }

    const finalUrl = response.url || current.href;
    const status = response.status;
    if (!isTextDocument(response.headers.get("content-type"))) {
      await discard(response);
      return { url: finalUrl, status, title: null };
    }

    const html = await readLimited(response);
    return { url: finalUrl, status, title: extractTitle(html) };
  }
}

function parsePublicUrl(rawUrl: string): URL {
  if (rawUrl.length > MAX_URL_LENGTH) throw new PageFetchError("URL is too long.");
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new PageFetchError("Invalid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PageFetchError("Only http and https URLs are supported.");
  }
  if (url.username || url.password) {
    throw new PageFetchError("URLs with credentials are not supported.");
  }
  if (!normalizeHost(url.hostname)) throw new PageFetchError("Invalid URL.");
  return url;
}

async function assertAllowed(
  url: URL,
  lookupImpl: (hostname: string) => Promise<ResolvedAddress[]>,
  signal: AbortSignal,
): Promise<void> {
  const host = normalizeHost(url.hostname);
  if (!host || isBlockedName(host)) throw new PageFetchError("That host is not allowed.");

  const version = ipVersion(host);
  if (version) {
    if (blockedIps.check(host, version)) throw new PageFetchError("That host is not allowed.");
    return;
  }

  let records: ResolvedAddress[];
  try {
    records = await waitFor(lookupImpl(host), signal);
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new PageFetchError("Could not resolve host.");
  }
  if (records.length === 0) throw new PageFetchError("Could not resolve host.");
  for (const record of records) {
    if (isBlockedAddress(record.address, record.family)) {
      throw new PageFetchError("That host is not allowed.");
    }
  }
}

function normalizeHost(hostname: string): string {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.endsWith(".")) host = host.slice(0, -1);
  return host;
}

function isBlockedName(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "metadata.google.internal" ||
    host.endsWith(".metadata.google.internal")
  );
}

function ipVersion(address: string): "ipv4" | "ipv6" | null {
  const family = isIP(address);
  if (family === 4) return "ipv4";
  if (family === 6) return "ipv6";
  return null;
}

function isBlockedAddress(address: string, family: number): boolean {
  const version = family === 6 ? "ipv6" : family === 4 ? "ipv4" : ipVersion(address);
  if (!version) return true;
  return blockedIps.check(address, version);
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isTextDocument(contentType: string | null): boolean {
  if (!contentType) return true;
  const mime = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    mime === "text/html" ||
    mime === "application/xhtml+xml" ||
    mime === "text/plain" ||
    mime === "text/xml" ||
    mime === "application/xml" ||
    mime.endsWith("+xml")
  );
}

async function readLimited(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let received = 0;
  let html = "";
  try {
    while (received < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      html += decoder.decode(value, { stream: true });
      if (TITLE_OR_HEAD.test(html)) break;
    }
  } finally {
    html += decoder.decode();
    await reader.cancel().catch(() => undefined);
  }
  return html;
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function resolveTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new PageFetchError(`timeoutMs must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}.`);
  }
  return timeoutMs;
}

async function defaultLookup(hostname: string): Promise<ResolvedAddress[]> {
  return lookup(hostname, { all: true, verbatim: true });
}

function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error ? signal.reason : new Error("The operation was aborted.");
}

function asPageError(error: unknown, timeoutMs: number): PageFetchError {
  if (error instanceof PageFetchError) return error;
  if (isAbort(error)) return new PageFetchError(`Request timed out after ${timeoutMs}ms.`);
  const detail = error instanceof Error ? error.message.replace(/\s+/g, " ").trim().slice(0, 200) : "";
  return new PageFetchError(detail ? `Request failed: ${detail}` : "Request failed.");
}

function isAbort(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("name" in error)) return false;
  return error.name === "AbortError" || error.name === "TimeoutError";
}

function decodeHtml(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (entity, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      return fromCode(Number.parseInt(body.slice(2), 16), entity);
    }
    if (body.startsWith("#")) return fromCode(Number.parseInt(body.slice(1), 10), entity);
    return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
  });
}

function fromCode(code: number, fallback: string): string {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
    return fallback;
  }
  return String.fromCodePoint(code);
}
