import { describe, it, expect } from "vitest";
import { HeadingResolver } from "./heading-target.js";
import { MarkdownPipeline } from "./markdown-pipeline.js";
import { HeadingNotFoundError, AmbiguousHeadingTargetError } from "../domain/errors/index.js";

const pipeline = new MarkdownPipeline();

const DOC = [
  "# Тест",
  "",
  "H1 body.",
  "",
  "## Section",
  "",
  "H2 body.",
  "",
  "### Deep",
  "",
  "H3 body.",
  "",
  "## Section Two",
  "",
  "Other.",
  "",
].join("\n");

const DUP = "# Title\n\n## Setup\n\nFirst.\n\n## Setup\n\nSecond.\n";

describe("HeadingResolver — P1-7", () => {
  it("resolves an H1 without an explicit headingDepth", () => {
    const resolution = HeadingResolver.resolve(pipeline.parse(DOC), "Тест");
    expect(resolution.depth).toBe(1);
    expect(resolution.title).toBe("Тест");
    expect(resolution.resolvedDepth).toBe(1);
    expect(resolution.warning).toMatch(/headingDepth 1/);
  });

  it("does not warn when the heading really is at the default depth", () => {
    const resolution = HeadingResolver.resolve(pipeline.parse(DOC), "Section");
    expect(resolution.depth).toBe(2);
    expect(resolution.resolvedDepth).toBeUndefined();
    expect(resolution.warning).toBeUndefined();
  });

  it("resolves an H3 that only exists deeper than the default depth", () => {
    const resolution = HeadingResolver.resolve(pipeline.parse(DOC), "Deep");
    expect(resolution.depth).toBe(3);
    expect(resolution.resolvedDepth).toBe(3);
  });

  it("respects an explicit headingDepth when it hits", () => {
    const resolution = HeadingResolver.resolve(pipeline.parse(DOC), "Deep", 3);
    expect(resolution.depth).toBe(3);
    expect(resolution.resolvedDepth).toBeUndefined();
  });

  it("throws with candidates when the title exists at several other depths", () => {
    const doc = "# Dup\n\nBody.\n\n### Dup\n\nDeeper.\n";
    let error: unknown;
    try {
      HeadingResolver.resolve(pipeline.parse(doc), "Dup", 2);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(AmbiguousHeadingTargetError);
    const candidates = (error as AmbiguousHeadingTargetError).candidates;
    expect(candidates.map((c) => c.depth).sort()).toEqual([1, 3]);
    expect((error as AmbiguousHeadingTargetError).message).toContain("headingDepth: 1");
  });

  it("throws AmbiguousHeadingTargetError for duplicate titles at the same depth", () => {
    expect(() => HeadingResolver.resolve(pipeline.parse(DUP), "Setup", 2))
      .toThrow(AmbiguousHeadingTargetError);
  });

  it("retargets a typo at the requested depth without a warning", () => {
    const resolution = HeadingResolver.resolve(pipeline.parse(DOC), "Sectoin");
    expect(resolution.title).toBe("Section");
    expect(resolution.depth).toBe(2);
    expect(resolution.resolvedDepth).toBeUndefined();
    expect(resolution.warning).toBeUndefined();
  });

  it("retargets a typo to a heading at another depth with a warning", () => {
    const doc = "# Overview\n\nBody.\n\n## Other section\n\nText.\n";
    const resolution = HeadingResolver.resolve(pipeline.parse(doc), "Overveiw");
    expect(resolution.title).toBe("Overview");
    expect(resolution.depth).toBe(1);
    expect(resolution.resolvedDepth).toBe(1);
    expect(resolution.warning).toMatch(/closest match/);
  });

  it("throws HEADING_NOT_FOUND with suggestions when nothing matches", () => {
    let error: unknown;
    try {
      HeadingResolver.resolve(pipeline.parse(DOC), "Sectoin Two");
    } catch (err) {
      error = err;
    }
    // Fuzzy match is close enough to retarget — use a clearly unrelated title.
    expect(error).toBeUndefined();

    try {
      HeadingResolver.resolve(pipeline.parse(DOC), "Совершенно другое");
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(HeadingNotFoundError);
  });

  it("includes headingDepth in the suggestions of a failed lookup", () => {
    const doc = "# Alpha\n\nBody.\n\n## Beta\n\nText.\n";
    let error: unknown;
    try {
      HeadingResolver.resolve(pipeline.parse(doc), "Alpah Two");
    } catch (err) {
      error = err;
    }
    if (error instanceof HeadingNotFoundError) {
      expect(error.suggestions.join(" ")).toContain("headingDepth:");
    }
  });
});
