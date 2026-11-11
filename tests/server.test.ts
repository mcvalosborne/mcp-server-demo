import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";

describe("MCP server", () => {
  it("advertises the tools and server-info resource", async () => {
    const server = createServer();
    const client = new Client({ name: "test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "convert_units",
        "fetch_page_title",
        "word_count",
      ]);
      const wordCount = listed.tools.find((tool) => tool.name === "word_count");
      expect(wordCount?.inputSchema).toMatchObject({
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      });

      const counted = await client.callTool({ name: "word_count", arguments: { text: "one two" } });
      expect(counted.isError).not.toBe(true);
      expect(JSON.parse(textContent(counted))).toMatchObject({ words: 2 });

      const mixed = await client.callTool({
        name: "convert_units",
        arguments: { value: 1, from: "km", to: "kg" },
      });
      expect(mixed.isError).toBe(true);

      const badUrl = await client.callTool({
        name: "fetch_page_title",
        arguments: { url: "not a url" },
      });
      expect(badUrl.isError).toBe(true);

      const resource = await client.readResource({ uri: "info://server" });
      const body = resource.contents[0];
      expect(body && "text" in body ? JSON.parse(body.text ?? "{}") : {}).toMatchObject({
        name: "mcp-server-demo",
        tools: ["word_count", "convert_units", "fetch_page_title"],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content.find((item) => item.type === "text");
  return block?.text ?? "";
}
