import { describe, it, expect } from "vitest";
import {
  hasHiddenSegment,
  hasIgnoredSegment,
  isIgnoredPath,
  matchesIgnorePattern,
  parseVaultIgnoreEnv,
  parseVaultIgnoreFile,
  filterIgnoredPaths,
} from "./vault-ignore.js";

describe("vault-ignore — default service directories (P0-3)", () => {
  it("detects dot-prefixed path segments", () => {
    expect(hasHiddenSegment(".trash/note.md")).toBe(true);
    expect(hasHiddenSegment(".stversions/Встречи/2026-09-15~20260915-143824.md")).toBe(true);
    expect(hasHiddenSegment("Встречи/2026-09-15.md")).toBe(false);
    expect(hasHiddenSegment("Agent/_MOC.md")).toBe(false);
  });

  it("detects node_modules as an ignored segment", () => {
    expect(hasIgnoredSegment("node_modules/pkg/readme.md")).toBe(true);
    expect(hasIgnoredSegment("projects/node_modules/pkg/readme.md")).toBe(true);
    expect(hasIgnoredSegment("nodes/readme.md")).toBe(false);
  });

  it("ignores every service directory that leaked into listings", () => {
    for (const p of [
      ".stversions/Встречи/x.md",
      ".trash/y.md",
      ".obsidian/templates/t.md",
      ".stfolder/z.md",
      ".markdown_vault_mcp/index.md",
      ".hidden.md",
    ]) {
      expect(isIgnoredPath(p, [])).toBe(true);
    }
  });

  it("keeps real notes", () => {
    for (const p of ["Встречи/2026-09-15.md", "Agent/pitfalls/README.md", "!Inbox/x.md"]) {
      expect(isIgnoredPath(p, [])).toBe(false);
    }
  });

  it("includeHidden bypasses every ignore rule", () => {
    expect(isIgnoredPath(".trash/y.md", ["Archive/**"], true)).toBe(false);
    expect(filterIgnoredPaths([".trash/y.md", "a.md"], [], true)).toEqual([
      ".trash/y.md",
      "a.md",
    ]);
  });
});

describe("vault-ignore — configured patterns", () => {
  it("parses VAULT_IGNORE as CSV", () => {
    expect(parseVaultIgnoreEnv("Archive/**, drafts/** ,,")).toEqual([
      "Archive/**",
      "drafts/**",
    ]);
    expect(parseVaultIgnoreEnv(undefined)).toEqual([]);
  });

  it("parses .vaultignore, skipping blanks and comments", () => {
    expect(parseVaultIgnoreFile("# comment\n\nArchive/**\n  drafts/*  \n")).toEqual([
      "Archive/**",
      "drafts/*",
    ]);
  });

  it("matches a pattern against the path itself", () => {
    expect(matchesIgnorePattern("Archive/old.md", "Archive/**")).toBe(true);
    expect(matchesIgnorePattern("Archive/old.md", "Other/**")).toBe(false);
  });

  it("matches a path nested inside a matched directory", () => {
    expect(matchesIgnorePattern("Archive/2024/old.md", "Archive")).toBe(true);
    expect(matchesIgnorePattern("ArchiveX/old.md", "Archive")).toBe(false);
  });

  it("filters configured patterns but keeps others", () => {
    const paths = ["a.md", "Archive/x.md", "drafts/y.md", ".trash/z.md"];
    expect(filterIgnoredPaths(paths, ["Archive/**"])).toEqual(["a.md", "drafts/y.md"]);
  });
});
