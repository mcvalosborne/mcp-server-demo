import { describe, expect, it } from "vitest";
import { extractTitle, fetchPageTitle, type ResolvedAddress } from "../src/tools/fetch-page-title.js";

const PUBLIC: ResolvedAddress[] = [{ address: "93.184.216.34", family: 4 }];

function html(body: string, status = 200, headers?: HeadersInit): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}

describe("extractTitle", () => {
  it("reads a title and decodes entities", () => {
    expect(extractTitle("<html><head><title>Hello &amp; Co</title></head></html>")).toBe("Hello & Co");
    expect(extractTitle("<title>Smile &#x263A;</title>")).toBe("Smile ☺");
  });

  it("collapses whitespace and ignores a missing title", () => {
    expect(extractTitle("<title> \n Hello \n world </title>")).toBe("Hello world");
    expect(extractTitle("<html><head></head></html>")).toBeNull();
    expect(extractTitle("<title>   </title>")).toBeNull();
  });

  it("keeps angle brackets that are part of the title text", () => {
    expect(extractTitle("<title>Using <canvas> for graphs</title>")).toBe("Using <canvas> for graphs");
    expect(extractTitle("<title>Using &lt;canvas&gt; for graphs</title>")).toBe("Using <canvas> for graphs");
  });
});

describe("fetchPageTitle", () => {
  it("returns the title, status, and final URL", async () => {
    const result = await fetchPageTitle("https://example.com/docs", {
      lookupImpl: async () => PUBLIC,
      fetchImpl: async () => html("<title>Docs</title>"),
    });
    expect(result).toEqual({ url: "https://example.com/docs", status: 200, title: "Docs" });
  });

  it("keeps a title from an error page", async () => {
    const result = await fetchPageTitle("https://example.com/missing", {
      lookupImpl: async () => PUBLIC,
      fetchImpl: async () => html("<title>Not found</title>", 404),
    });
    expect(result).toMatchObject({ status: 404, title: "Not found" });
  });

  it("does not read a non-text body", async () => {
    const result = await fetchPageTitle("https://example.com/picture", {
      lookupImpl: async () => PUBLIC,
      fetchImpl: async () => new Response("not-html", { status: 200, headers: { "content-type": "image/png" } }),
    });
    expect(result.title).toBeNull();
  });

  it("follows a redirect and checks the next host", async () => {
    const seen: string[] = [];
    const result = await fetchPageTitle("https://example.com/start", {
      lookupImpl: async (hostname) => {
        seen.push(hostname);
        return PUBLIC;
      },
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.startsWith("https://example.com/start")) {
          return new Response(null, { status: 302, headers: { location: "https://example.org/next" } });
        }
        return html("<title>Next</title>");
      },
    });
    expect(result.title).toBe("Next");
    expect(seen).toEqual(["example.com", "example.org"]);
  });

  it("rejects a redirect to a loopback address", async () => {
    await expect(
      fetchPageTitle("https://example.com/go", {
        lookupImpl: async () => PUBLIC,
        fetchImpl: async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } }),
      }),
    ).rejects.toThrow(/not allowed/);
  });

  it("rejects private, loopback, and local names before fetching", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("fetch should not be called");
    };
    const blocked = [
      "http://127.0.0.1/",
      "http://10.1.2.3/",
      "http://192.168.0.5/",
      "http://172.16.0.1/latest",
      "http://169.254.169.254/",
      "http://100.64.1.1/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://localhost/admin",
      "http://printer.local/",
      "file:///etc/passwd",
      "http://user:pass@example.com/",
      "not a url",
    ];
    for (const url of blocked) {
      await expect(fetchPageTitle(url, { fetchImpl })).rejects.toThrow(
        /not allowed|Only http and https|credentials|Invalid URL/,
      );
    }
  });

  it("rejects a name that resolves to a private address", async () => {
    await expect(
      fetchPageTitle("https://example.com/", {
        lookupImpl: async () => [{ address: "10.0.0.8", family: 4 }],
        fetchImpl: async () => html("<title>hidden</title>"),
      }),
    ).rejects.toThrow(/not allowed/);
  });

  it("does not resolve an address literal", async () => {
    let lookups = 0;
    const result = await fetchPageTitle("http://8.8.8.8/", {
      lookupImpl: async () => {
        lookups += 1;
        return PUBLIC;
      },
      fetchImpl: async () => html("<title>DNS</title>"),
    });
    expect(result.title).toBe("DNS");
    expect(lookups).toBe(0);
  });

  it("times out when the response never arrives", async () => {
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        const fail = () => reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
        if (!signal) {
          fail();
          return;
        }
        if (signal.aborted) fail();
        else signal.addEventListener("abort", fail, { once: true });
      });

    await expect(
      fetchPageTitle("https://example.com/", {
        timeoutMs: 100,
        lookupImpl: async () => PUBLIC,
        fetchImpl,
      }),
    ).rejects.toThrow(/timed out after 100ms/);
  });

  it("rejects a timeout outside the allowed range", async () => {
    await expect(fetchPageTitle("https://example.com/", { timeoutMs: 50 })).rejects.toThrow(/timeoutMs/);
  });

  it("decodes the title with the charset declared on the response", async () => {
    const bytes = Uint8Array.from([...Buffer.from("<title>Caf"), 0xe9, ...Buffer.from("</title>")]);
    const result = await fetchPageTitle("https://example.com/", {
      lookupImpl: async () => PUBLIC,
      fetchImpl: async () => htmlStream(bytes, "text/html; charset=iso-8859-1"),
    });
    expect(result.title).toBe("Café");
  });

  it("ignores a title that begins past the 64 KiB body cap", async () => {
    const bytes = Buffer.concat([Buffer.alloc(100_000, 0x20), Buffer.from("<title>past limit</title>")]);
    const result = await fetchPageTitle("https://example.com/", {
      lookupImpl: async () => PUBLIC,
      fetchImpl: async () => htmlStream(bytes, "text/html; charset=utf-8"),
    });
    expect(result.title).toBeNull();
  });

  it("reads a title that sits inside the first 64 KiB of a large chunk", async () => {
    const bytes = Buffer.concat([Buffer.from("<title>Inside</title>"), Buffer.alloc(100_000, 0x20)]);
    const result = await fetchPageTitle("https://example.com/", {
      lookupImpl: async () => PUBLIC,
      fetchImpl: async () => htmlStream(bytes, "text/html; charset=utf-8"),
    });
    expect(result.title).toBe("Inside");
  });
});

function htmlStream(bytes: Uint8Array, contentType: string): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": contentType } },
  );
}
