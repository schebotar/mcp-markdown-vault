import { describe, it, expect } from "vitest";
import {
  findNearestLine,
  buildStringNotFoundMessage,
  logStringReplaceFailure,
} from "./string-not-found.js";

const SOURCE = [
  "# Title",
  "",
  "Some intro text.",
  "Target line with [[Agent/regulations/обработка-встреч]] and details.",
  "Another line.",
].join("\n");

describe("findNearestLine", () => {
  it("finds the closest line by Levenshtein similarity", () => {
    const nearest = findNearestLine(
      SOURCE,
      "Target line with [[Agent/regulations/обработка-встреч]] and detail",
    );

    expect(nearest).not.toBeNull();
    expect(nearest!.lineNumber).toBe(4);
    expect(nearest!.similarity).toBeGreaterThanOrEqual(0.6);
  });

  it("matches a partial fragment via the token fallback", () => {
    const nearest = findNearestLine(SOURCE, "Target line");

    expect(nearest).not.toBeNull();
    expect(nearest!.lineNumber).toBe(4);
  });

  it("returns a best-effort line for unrelated input", () => {
    const nearest = findNearestLine(SOURCE, "completely unrelated zzz");

    expect(nearest).not.toBeNull();
  });

  it("returns null for an empty source", () => {
    expect(findNearestLine("", "anything")).toBeNull();
  });
});

describe("buildStringNotFoundMessage", () => {
  it("includes fingerprint, nearest line number and a line_replace hint", () => {
    const message = buildStringNotFoundMessage(
      "Target line with [[Agent/regulations/обработка-встреч]] and detail",
      SOURCE,
      { sizeBytes: 123, mtime: "2026-09-14T00:00:00.000Z", sha256: "abcdef123456" },
    );

    expect(message).toContain("Search string not found");
    expect(message).toContain("size=123B");
    expect(message).toContain("sha256=abcdef123456");
    expect(message).toContain("nearest line 4");
    expect(message).toContain("line_replace startLine=4 endLine=4");
    expect(message).toContain("expectLine=");
  });

  it("omits the fingerprint block when none is provided", () => {
    const message = buildStringNotFoundMessage("nonexistent", SOURCE);

    expect(message).toContain("Search string not found");
    expect(message).not.toContain("size=");
    expect(message).toContain("nearest line");
  });
});

describe("logStringReplaceFailure", () => {
  it("is silent (and safe) unless MCP_DEBUG=1", () => {
    const original = process.env["MCP_DEBUG"];
    delete process.env["MCP_DEBUG"];
    try {
      expect(() => logStringReplaceFailure("x", SOURCE)).not.toThrow();
    } finally {
      if (original !== undefined) process.env["MCP_DEBUG"] = original;
    }
  });
});
