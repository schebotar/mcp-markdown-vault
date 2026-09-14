import { describe, it, expect } from "vitest";
import { matchGlob } from "./glob.js";

const PATHS = ["a.md", "dir/b.md", "dir/deep/c.md", "other/d.md"];

describe("matchGlob", () => {
  it("matches ** across path segments", () => {
    expect(matchGlob("dir/**/*.md", PATHS)).toEqual([
      "dir/b.md",
      "dir/deep/c.md",
    ]);
  });

  it("matches * within a single segment", () => {
    expect(matchGlob("*.md", PATHS)).toEqual(["a.md"]);
  });

  it("supports a leading **/ so root files also match", () => {
    expect(matchGlob("**/*.md", PATHS)).toEqual(PATHS);
  });

  it("supports ? for a single character", () => {
    expect(matchGlob("?.md", PATHS)).toEqual(["a.md"]);
  });

  it("treats dots literally", () => {
    expect(matchGlob("a.md", PATHS)).toEqual(["a.md"]);
  });

  it("matches literal directory paths", () => {
    expect(matchGlob("other/**", PATHS)).toEqual(["other/d.md"]);
  });
});
