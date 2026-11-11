import { describe, expect, it } from "vitest";
import { countWords } from "../src/tools/word-count.js";

describe("countWords", () => {
  it("returns zeros for an empty string", () => {
    expect(countWords("")).toEqual({
      words: 0,
      characters: 0,
      charactersExcludingWhitespace: 0,
      lines: 0,
    });
  });

  it("counts words separated by repeated whitespace", () => {
    expect(countWords("  one \t two  ")).toMatchObject({ words: 2, charactersExcludingWhitespace: 6 });
  });

  it("does not count a trailing newline as an extra line", () => {
    expect(countWords("hello\nworld\n")).toMatchObject({ words: 2, lines: 2 });
    expect(countWords("hello\nworld")).toMatchObject({ lines: 2 });
    expect(countWords("\n")).toMatchObject({ words: 0, lines: 1 });
  });

  it("treats CRLF as a single line break", () => {
    expect(countWords("one\r\ntwo")).toMatchObject({ words: 2, lines: 2 });
  });

  it("counts Unicode code points, including emoji", () => {
    expect(countWords("a 😀")).toEqual({
      words: 2,
      characters: 3,
      charactersExcludingWhitespace: 2,
      lines: 1,
    });
  });

  it("treats non-breaking space as whitespace", () => {
    expect(countWords("a\u00a0b")).toMatchObject({ words: 2, characters: 3, charactersExcludingWhitespace: 2 });
  });
});
