import { describe, it, expect } from "vitest";
import { mergeFrontmatterPreservingStyle } from "./frontmatter-surgery.js";

describe("mergeFrontmatterPreservingStyle — P1-5", () => {
  it("rewrites only the touched key and keeps the rest byte-for-byte", () => {
    const source =
      '---\ntitle: "scratch vault test"\ntags:\n  - markdown-vault\n  - mcp\n---\n\n# Body\n\n- dash bullet\n\ncall send_mail()\n';

    const result = mergeFrontmatterPreservingStyle(source, { status: "draft" });

    expect(result.content).toBe(
      '---\ntitle: "scratch vault test"\ntags:\n  - markdown-vault\n  - mcp\nstatus: draft\n---\n\n# Body\n\n- dash bullet\n\ncall send_mail()\n',
    );
    expect(result.addedKeys).toEqual(["status"]);
    expect(result.updatedKeys).toEqual([]);
  });

  it("keeps the double-quoting style of a rewritten string key", () => {
    const source = '---\ntitle: "scratch vault test"\n---\n\nBody\n';

    const result = mergeFrontmatterPreservingStyle(source, { title: "renamed" });

    expect(result.content).toContain('title: "renamed"');
    expect(result.updatedKeys).toEqual(["title"]);
  });

  it("keeps the position of an updated key and appends new keys at the end", () => {
    const source = "---\na: 1\nb: 2\nc: 3\n---\nBody\n";

    const result = mergeFrontmatterPreservingStyle(source, { b: 20, d: 4 });

    expect(result.content).toBe("---\na: 1\nb: 20\nc: 3\nd: 4\n---\nBody\n");
    expect(result.updatedKeys).toEqual(["b"]);
    expect(result.addedKeys).toEqual(["d"]);
  });

  it("keeps comments on untouched keys and a trailing comment on a touched one", () => {
    const source = "---\na: 1 # keep me\nb: 2\n---\nBody\n";

    const result = mergeFrontmatterPreservingStyle(source, { b: 3 });

    expect(result.content).toContain("a: 1 # keep me");
    expect(result.content).toContain("b: 3");
  });

  it("creates the whole block when the note has no frontmatter", () => {
    const result = mergeFrontmatterPreservingStyle("# Body\n", { status: "draft" });

    expect(result.content).toBe("---\nstatus: draft\n---\n\n# Body\n");
    expect(result.addedKeys).toEqual(["status"]);
  });

  it("dumps arrays and nested objects YAML-style", () => {
    const source = "---\ntitle: Hi\n---\nBody\n";

    const result = mergeFrontmatterPreservingStyle(source, {
      tags: ["a", "b"],
      meta: { owner: "sergey" },
    });

    expect(result.content).toContain("tags:\n  - a\n  - b");
    expect(result.content).toContain("meta:\n  owner: sergey");
    expect(result.content).toContain("title: Hi");
  });

  it("preserves the markdown body byte-for-byte (no remark normalization)", () => {
    const body = "\n- dash\n\n| --- | --- |\n\nsend_mail and [[Agent/_MOC.md]]\n";
    const source = `---\ntitle: Hi\n---${body}`;

    const result = mergeFrontmatterPreservingStyle(source, { status: "draft" });

    expect(result.content.endsWith(body)).toBe(true);
    expect(result.content).not.toContain("* dash");
    expect(result.content).not.toContain("send\\_mail");
    expect(result.content).not.toContain("Agent/\\_MOC");
  });
});
