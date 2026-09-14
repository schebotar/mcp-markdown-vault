import { describe, it, expect } from "vitest";
import { checkContentSanity } from "./content-sanity.js";

describe("checkContentSanity", () => {
  it("returns no warnings for clean content", () => {
    expect(checkContentSanity("plain markdown text")).toEqual([]);
  });

  it("flags a literal backslash-n", () => {
    expect(checkContentSanity("foo\\nbar")).toHaveLength(1);
  });

  it("flags HTML entities", () => {
    expect(checkContentSanity("&#x6E; and &amp;")).toHaveLength(1);
  });

  it("flags escaped underscores outside code", () => {
    expect(checkContentSanity("call send\\_mail now")).toHaveLength(1);
  });

  it("ignores escaped underscores inside code spans/fences", () => {
    expect(checkContentSanity("`send\\_mail`")).toEqual([]);
  });
});
