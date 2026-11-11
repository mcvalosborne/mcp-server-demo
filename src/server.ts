import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerConvertUnits } from "./tools/convert-units.js";
import { registerFetchPageTitle } from "./tools/fetch-page-title.js";
import { registerWordCount } from "./tools/word-count.js";

const SERVER_NAME = "mcp-server-demo";
const SERVER_VERSION = "1.0.0";

export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  registerWordCount(server);
  registerConvertUnits(server);
  registerFetchPageTitle(server);

  server.registerResource(
    "server-info",
    "info://server",
    {
      description: "Name, version, and tools exposed by this server.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(
            {
              name: SERVER_NAME,
              version: SERVER_VERSION,
              tools: ["word_count", "convert_units", "fetch_page_title"],
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  return server;
}
