/**
 * Vault ignore rules.
 *
 * Service directories (`.obsidian`, `.trash`, `.stversions`, `.stfolder`,
 * `.markdown_vault_mcp`, …) are never real notes: they used to leak into
 * `vault list`, `view.glob`, `view.semantic_search`, the vector index and the
 * overview, so every consumer had its own — or no — filtering and the counts
 * disagreed.
 *
 * The rules live here and are applied once, in
 * {@link IFileSystemAdapter.listNotes}, so all consumers agree:
 *
 * 1. any path segment starting with `.` is ignored (unless `includeHidden`);
 * 2. extra glob patterns from `VAULT_IGNORE` (CSV) and `.vaultignore`
 *    (one pattern per line, `#` comments) are ignored as well.
 */

import { globToRegExp } from "./glob.js";

/**
 * Directory names that are never note content even though they have no
 * leading dot (`node_modules` used to be filtered by the overview only, which
 * is exactly how the counts diverged).
 */
const DEFAULT_IGNORED_SEGMENTS = new Set(["node_modules"]);

/** True when any segment of a vault-relative path starts with a dot. */
export function hasHiddenSegment(relPath: string): boolean {
  return relPath
    .split(/[/\\]/)
    .some((segment) => segment.length > 0 && segment.startsWith("."));
}

/** True when any segment is a service directory (dot-prefixed or node_modules). */
export function hasIgnoredSegment(relPath: string): boolean {
  return relPath
    .split(/[/\\]/)
    .some(
      (segment) =>
        segment.length > 0
        && (segment.startsWith(".") || DEFAULT_IGNORED_SEGMENTS.has(segment)),
    );
}

/** Parse the `VAULT_IGNORE` environment value (CSV of glob patterns). */
export function parseVaultIgnoreEnv(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Parse the contents of a `.vaultignore` file. */
export function parseVaultIgnoreFile(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

const REGEX_CACHE = new Map<string, RegExp>();

function regexFor(pattern: string): RegExp {
  let cached = REGEX_CACHE.get(pattern);
  if (cached === undefined) {
    cached = globToRegExp(pattern);
    REGEX_CACHE.set(pattern, cached);
  }
  return cached;
}

/**
 * True when `relPath` matches `pattern` directly or sits inside a directory
 * that matches it (so the pattern `.stversions` also excludes
 * `.stversions/x.md`).
 */
export function matchesIgnorePattern(relPath: string, pattern: string): boolean {
  const normalized = pattern.replace(/^\.\//, "").replace(/\/+$/, "");
  if (normalized.length === 0) return false;

  const regex = regexFor(normalized);
  const segments = relPath.split("/");

  for (let i = 0; i <= segments.length; i++) {
    const candidate = segments.slice(0, i).join("/");
    if (candidate.length === 0) continue;
    if (regex.test(candidate)) return true;
  }
  return false;
}

/** True when the vault-relative path must be excluded from note listings. */
export function isIgnoredPath(
  relPath: string,
  patterns: readonly string[],
  includeHidden = false,
): boolean {
  if (includeHidden) return false;
  if (hasIgnoredSegment(relPath)) return true;
  for (const pattern of patterns) {
    if (matchesIgnorePattern(relPath, pattern)) return true;
  }
  return false;
}

/** Filter a list of vault-relative paths, preserving order. */
export function filterIgnoredPaths(
  paths: readonly string[],
  patterns: readonly string[],
  includeHidden = false,
): string[] {
  if (includeHidden) return [...paths];
  return paths.filter((relPath) => !isIgnoredPath(relPath, patterns, false));
}
