import { describe, it, expect } from "vitest";
import {
  extractFrontmatterRaw,
  replaceFrontmatterBlock,
} from "./frontmatter-surgery.js";

describe("extractFrontmatterRaw", () => {
  it("returns the YAML between the fences", () => {
    expect(
      extractFrontmatterRaw("---\ntitle: Hi\ntags: [a]\n---\n\n# Body\n"),
    ).toBe("title: Hi\ntags: [a]");
  });

  it("returns undefined when there is no frontmatter", () => {
    expect(extractFrontmatterRaw("# Body\n")).toBeUndefined();
  });
});

describe("replaceFrontmatterBlock", () => {
  it("replaces only the frontmatter and preserves the body byte-for-byte", () => {
    const source =
      "---\ntitle: Hi\n---\n\n# Body\n\n- item one\n- item two\n\ncall send_mail() now\n";

    const result = replaceFrontmatterBlock(source, "title: Hi\nstatus: draft");

    expect(result).toContain("title: Hi\nstatus: draft");
    expect(result).toContain(
      "# Body\n\n- item one\n- item two\n\ncall send_mail() now\n",
    );
    // The body must not be normalized by remark-stringify.
    expect(result).not.toContain("* item one");
    expect(result).not.toContain("send\\_mail");
  });

  it("inserts a frontmatter block when none exists", () => {
    expect(replaceFrontmatterBlock("# Body\n", "title: New")).toBe(
      "---\ntitle: New\n---\n\n# Body\n",
    );
  });

  it("handles an empty file", () => {
    expect(replaceFrontmatterBlock("", "title: New")).toBe(
      "---\ntitle: New\n---\n",
    );
  });

  it("preserves CRLF line endings", () => {
    const source = "---\r\ntitle: Hi\r\n---\r\n\r\n# Body\r\n";

    const result = replaceFrontmatterBlock(
      source,
      "title: Hi\r\nstatus: draft",
    );

    expect(result).toContain("\r\n# Body\r\n");
    expect(result).toContain("status: draft");
  });
});
