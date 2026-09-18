import { describe, it, expect } from "vitest";
import { TextPatcher } from "./text-patcher.js";
import type { PatchOperation } from "./ast-patcher.js";
import { MarkdownPipeline } from "./markdown-pipeline.js";
import { UnsafeDeleteTargetError } from "../domain/errors/index.js";

const pipeline = new MarkdownPipeline();

/** A note that remark-stringify would happily rewrite: dash bullets, a table
 *  with narrow pipes, underscores and an escaped wiki-link. */
const TRICKY = [
  "---",
  "title: scratch vault test",
  "---",
  "",
  "- пункт с дефисом",
  "",
  "| a | b |",
  "| --- | --- |",
  "| 1 | 2 |",
  "",
  "Строка с wiki-ссылкой: \\[\\[Agent/_MOC.md]] и подчёркивание send_mail.",
  "",
  "- [ ] задача",
  "",
].join("\n");

function op(type: PatchOperation["type"], content: string): PatchOperation {
  return { type, target: "document", content };
}

/** Assert that everything outside the appended line is untouched. */
function expectOnlyAddition(source: string, result: string, added: string): void {
  expect(result).toBe(`${source}\n${added}\n`);
}

describe("TextPatcher.applyDocument — P0-1 (byte-preserving)", () => {
  it("appends without re-serializing the rest of the file", () => {
    const content = "- новый пункт с подчёркиванием send_mail";

    const result = TextPatcher.applyDocument(TRICKY, op("append", content));

    expectOnlyAddition(TRICKY, result, content);
    // Nothing else was normalized.
    expect(result).not.toContain("* пункт с дефисом");
    expect(result).not.toContain("| --------- |");
    expect(result).not.toContain("send\\_mail");
    expect(result).not.toContain("Agent/\\_MOC");
    expect(result).toContain("\\[\\[Agent/_MOC.md]]");
  });

  it("prepends AFTER the frontmatter, keeping it first", () => {
    const content = "> вставка сверху";

    const result = TextPatcher.applyDocument(TRICKY, op("prepend", content));

    expect(result.startsWith("---\ntitle: scratch vault test\n---\n")).toBe(true);
    expect(result).toContain(`${content}\n\n- пункт с дефисом`);
  });

  it("prepends to the very top when there is no frontmatter", () => {
    const source = "# Body\n\nText.\n";

    const result = TextPatcher.applyDocument(source, op("prepend", "Inserted."));

    expect(result).toBe("Inserted.\n\n# Body\n\nText.\n");
  });

  it("replaces only the body and keeps the frontmatter", () => {
    const result = TextPatcher.applyDocument(TRICKY, op("replace", "New body."));

    expect(result).toBe("---\ntitle: scratch vault test\n---\n\nNew body.\n");
  });

  it("clearing the body keeps the frontmatter block", () => {
    const result = TextPatcher.applyDocument(TRICKY, op("replace", ""));
    expect(result).toBe("---\ntitle: scratch vault test\n---\n");
  });

  it("rejects deleting a whole document", () => {
    expect(() => TextPatcher.applyDocument(TRICKY, op("delete", "")))
      .toThrow(UnsafeDeleteTargetError);
  });

  it("is a no-op for empty append/prepend payloads", () => {
    expect(TextPatcher.applyDocument(TRICKY, op("append", ""))).toBe(TRICKY);
    expect(TextPatcher.applyDocument(TRICKY, op("prepend", "\n\n"))).toBe(TRICKY);
  });

  it("does not add a blank line when the file already ends with one", () => {
    const source = "Body\n\n";
    expect(TextPatcher.applyDocument(source, op("append", "Added."))).toBe(
      "Body\n\nAdded.\n",
    );
  });

  it("adds a trailing newline when the file has none", () => {
    const source = "Body";
    expect(TextPatcher.applyDocument(source, op("append", "Added."))).toBe(
      "Body\n\nAdded.\n",
    );
  });
});

describe("TextPatcher.apply — P0-2 (verbatim content)", () => {
  it("inserts content verbatim under a heading", () => {
    const source = "# Title\n\n## Section\n\nOld line.\n\n## Other\n\nKeep.\n";
    const tree = pipeline.parse(source);

    const result = TextPatcher.apply(source, tree, {
      type: "append",
      target: { heading: "Section", depth: 2 },
      content: "- dash bullet with send_mail and [[Agent/_MOC.md]]",
    });

    expect(result).toContain("- dash bullet with send_mail and [[Agent/_MOC.md]]");
    expect(result).not.toContain("* dash bullet");
    expect(result).not.toContain("send\\_mail");
    expect(result).toContain("## Other\n\nKeep.\n");
  });
});
