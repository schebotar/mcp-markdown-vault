import { describe, it, expect } from "vitest";
import {
  findPathViolations,
  findSegmentViolations,
  isPortablePath,
  describePortabilityViolations,
  parsePortablePathPolicy,
} from "./portable-path.js";

describe("parsePortablePathPolicy", () => {
  it("defaults to error/unicode when unset or empty", () => {
    expect(parsePortablePathPolicy(undefined)).toEqual({
      policy: "error",
      charset: "unicode",
    });
    expect(parsePortablePathPolicy("   ")).toEqual({
      policy: "error",
      charset: "unicode",
    });
  });

  it("parses off, error and warn", () => {
    expect(parsePortablePathPolicy("off").policy).toBe("off");
    expect(parsePortablePathPolicy("error").policy).toBe("error");
    expect(parsePortablePathPolicy("warn").policy).toBe("warn");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(parsePortablePathPolicy(" OFF ").policy).toBe("off");
    expect(parsePortablePathPolicy("Warn").policy).toBe("warn");
  });

  it("parses the strict-ascii suffix", () => {
    expect(parsePortablePathPolicy("warn:strict-ascii")).toEqual({
      policy: "warn",
      charset: "strict-ascii",
    });
    expect(parsePortablePathPolicy("error:strict-ascii")).toEqual({
      policy: "error",
      charset: "strict-ascii",
    });
  });

  it("treats a bare strict-ascii as an enforced ASCII-only policy", () => {
    expect(parsePortablePathPolicy("strict-ascii")).toEqual({
      policy: "error",
      charset: "strict-ascii",
    });
  });

  it("keeps Unicode names allowed under the default policy", () => {
    expect(parsePortablePathPolicy("unicode")).toEqual({
      policy: "error",
      charset: "unicode",
    });
  });

  it("falls back to the safe default on an unknown token (typo must not disable the guard)", () => {
    expect(parsePortablePathPolicy("errr")).toEqual({
      policy: "error",
      charset: "unicode",
    });
    expect(parsePortablePathPolicy("warn:strict")).toEqual({
      policy: "error",
      charset: "unicode",
    });
  });
});

describe("findSegmentViolations", () => {
  it("accepts ordinary names, including Cyrillic and spaces", () => {
    for (const name of [
      "note.md",
      "2024-01-01.md",
      "Встречи 12-30.md",
      "Заметка (черновик).md",
      "a+b=c&d.md",
      "#hashtag.md",
      "50%.md",
      "'quoted'.md",
      "…ellipsis.md",
    ]) {
      expect(findSegmentViolations(name), name).toEqual([]);
    }
  });

  it("rejects every Windows-reserved character", () => {
    for (const char of ["<", ">", ":", '"', "|", "?", "*"]) {
      const violations = findSegmentViolations(`meeting ${char}12.md`);
      expect(violations.map((v) => v.code), char).toContain("RESERVED_CHARACTER");
    }
  });

  it("names the offending character in the detail", () => {
    const [violation] = findSegmentViolations("12:30.md");
    expect(violation?.detail).toContain('":"');
    expect(violation?.segment).toBe("12:30.md");
    expect(violation?.code).toBe("RESERVED_CHARACTER");
  });

  it("rejects percent-encoded reserved characters (decoded like SafePath does)", () => {
    const violations = findSegmentViolations("12%3A30.md");
    expect(violations.map((v) => v.code)).toContain("RESERVED_CHARACTER");
  });

  it("rejects control characters", () => {
    expect(findSegmentViolations("note\u0007.md").map((v) => v.code)).toContain(
      "CONTROL_CHARACTER",
    );
    expect(findSegmentViolations("note\u007f.md").map((v) => v.code)).toContain(
      "CONTROL_CHARACTER",
    );
  });

  it("rejects a trailing dot or space", () => {
    expect(findSegmentViolations("note.").map((v) => v.code)).toContain(
      "TRAILING_DOT_OR_SPACE",
    );
    expect(findSegmentViolations("note ").map((v) => v.code)).toContain(
      "TRAILING_DOT_OR_SPACE",
    );
    expect(findSegmentViolations("note.md ").map((v) => v.code)).toContain("TRAILING_DOT_OR_SPACE");
  });

  it("allows dots and spaces inside a name (only the tail is stripped by Windows)", () => {
    expect(findSegmentViolations("note. .md")).toEqual([]);
    expect(findSegmentViolations("my note. v2.md")).toEqual([]);
  });

  it("rejects reserved device names, with and without extension, any case", () => {
    for (const name of ["CON", "con.md", "Aux.md", "NUL.txt", "com1.md", "LPT9.md", "PRN"]) {
      expect(
        findSegmentViolations(name).map((v) => v.code),
        name,
      ).toContain("RESERVED_DEVICE_NAME");
    }
  });

  it("allows names that merely start with a device name", () => {
    expect(findSegmentViolations("console.md")).toEqual([]);
    expect(findSegmentViolations("com10.md")).toEqual([]);
    expect(findSegmentViolations("nullable.md")).toEqual([]);
  });

  it("rejects names longer than 255 characters", () => {
    expect(findSegmentViolations(`${"a".repeat(256)}.md`).map((v) => v.code)).toContain(
      "NAME_TOO_LONG",
    );
    expect(findSegmentViolations(`${"a".repeat(200)}.md`)).toEqual([]);
  });

  it("allows non-ASCII names by default", () => {
    expect(findSegmentViolations("Встреча.md")).toEqual([]);
    expect(findSegmentViolations("заметка 🚀.md")).toEqual([]);
  });

  it("rejects non-ASCII names under strict-ascii", () => {
    const violations = findSegmentViolations("Встреча.md", { charset: "strict-ascii" });
    expect(violations.map((v) => v.code)).toContain("NON_ASCII_NAME");
    expect(violations[0]?.detail).toContain("Встреча.md".slice(0, 1));
  });

  it("reports several violations at once", () => {
    const codes = findSegmentViolations("aux.md ").map((v) => v.code);
    expect(codes).toContain("RESERVED_DEVICE_NAME");
    expect(codes).toContain("TRAILING_DOT_OR_SPACE");
  });

  it("keys the device-name check on the part before the first dot", () => {
    // "con:md" / "con:x?.md" have "con:" as their base, which is not the CON
    // device — only the reserved characters are a problem there.
    expect(findSegmentViolations("con:x?.md").map((v) => v.code)).toEqual([
      "RESERVED_CHARACTER",
    ]);
    expect(findSegmentViolations("con.md").map((v) => v.code)).toEqual([
      "RESERVED_DEVICE_NAME",
    ]);
  });

  it("does not treat a name as a device name once the character before the extension is part of the base", () => {
    expect(findSegmentViolations("CON: .md")).toEqual([
      expect.objectContaining({ code: "RESERVED_CHARACTER" }),
    ]);
  });
});

describe("findPathViolations", () => {
  it("accepts a portable nested path", () => {
    expect(findPathViolations("Встречи/2026/09-15 Заметка.md")).toEqual([]);
  });

  it("flags the offending segment and its index", () => {
    const violations = findPathViolations("Встречи/12:30/note.md");
    expect(violations).toHaveLength(1);
    expect(violations[0]?.segment).toBe("12:30");
    expect(violations[0]?.segmentIndex).toBe(1);
    expect(violations[0]?.path).toBe("Встречи/12:30/note.md");
  });

  it("checks every segment, not just the file name", () => {
    const violations = findPathViolations("a?b/c*d/note.md");
    expect(violations.map((v) => v.segment)).toEqual(["a?b", "c*d"]);
  });

  it("handles backslash-separated paths", () => {
    expect(findPathViolations("a?b\\note.md").map((v) => v.segment)).toEqual(["a?b"]);
  });

  it("ignores empty and dot segments", () => {
    expect(findPathViolations("daily//./note.md")).toEqual([]);
  });

  it("propagates the charset to every segment", () => {
    const violations = findPathViolations("Встречи/note.md", { charset: "strict-ascii" });
    expect(violations.map((v) => v.code)).toEqual(["NON_ASCII_NAME"]);
  });
});

describe("isPortablePath", () => {
  it("is true for portable paths and false otherwise", () => {
    expect(isPortablePath("daily/note.md")).toBe(true);
    expect(isPortablePath("daily/12:30.md")).toBe(false);
    expect(isPortablePath("Встречи/note.md", { charset: "strict-ascii" })).toBe(false);
  });
});

describe("describePortabilityViolations", () => {
  it("renders one readable line per violation with the machine code", () => {
    const lines = describePortabilityViolations(findSegmentViolations("12:30.md"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("12:30.md: contains character(s)");
    expect(lines[0]).toContain("[RESERVED_CHARACTER]");
  });
});
