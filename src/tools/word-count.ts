import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const wordCountInput = z.object({
  text: z.string().describe("Text to measure."),
});

export interface WordCount {
  words: number;
  characters: number;
  charactersExcludingWhitespace: number;
  lines: number;
}

/**
 * Counts words, Unicode code points, and lines.
 * A trailing newline does not create an extra line. An empty string has zero lines.
 */
export function countWords(text: string): WordCount {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const characters = [...normalized].length;
  const charactersExcludingWhitespace = [...normalized].filter((character) => !/\s/u.test(character)).length;
  const words = normalized.match(/\S+/gu)?.length ?? 0;

  return {
    words,
    characters,
    charactersExcludingWhitespace,
    lines: countLines(normalized),
  };
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  const parts = text.split("\n");
  if (text.endsWith("\n")) parts.pop();
  return parts.length;
}

export function registerWordCount(server: McpServer): void {
  server.registerTool(
    "word_count",
    {
      title: "Word count",
      description:
        "Count words, characters, and lines in text. Words are runs of non-whitespace. Characters are Unicode code points. Lines are separated by newlines, and a trailing newline does not add an extra line.",
      inputSchema: wordCountInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ text }) => ({
      content: [{ type: "text", text: JSON.stringify(countWords(text), null, 2) }],
    }),
  );
}
