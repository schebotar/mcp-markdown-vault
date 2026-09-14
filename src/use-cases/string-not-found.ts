import { FuzzyMatcher } from "./fuzzy-match.js";
import { sha256Short, type FileFingerprint } from "./file-fingerprint.js";

const SIMILARITY_THRESHOLD = 0.6;
const MIN_TOKEN_LENGTH = 3;

/** The line in a file that most closely resembles a failed search string. */
export interface NearestLine {
  /** 1-based line number. */
  lineNumber: number;
  /** Original text of the line (untrimmed). */
  text: string;
  /** Similarity in [0, 1] against the (trimmed, lower-cased) query. */
  similarity: number;
}

/**
 * Find the line in `source` most similar to `searchText`.
 *
 * Primary strategy: the line with the highest normalized Levenshtein
 * similarity (trimmed, case-insensitive). When the best score is below the
 * threshold, fall back to the line sharing the longest literal token with the
 * query ("nearest by substrings").
 *
 * Returns null only when the file has no non-empty lines.
 */
export function findNearestLine(source: string, searchText: string): NearestLine | null {
  const lines = source.split("\n");
  const query = searchText.trim().toLowerCase();

  let best: NearestLine | null = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const candidate = raw.trim();
    if (candidate.length === 0) continue;
    const maxLen = Math.max(query.length, candidate.length);
    const similarity = maxLen === 0
      ? 1
      : 1 - FuzzyMatcher.distance(query, candidate.toLowerCase()) / maxLen;
    if (best === null || similarity > best.similarity) {
      best = { lineNumber: i + 1, text: raw, similarity };
    }
  }

  if (best === null || best.similarity >= SIMILARITY_THRESHOLD) {
    return best;
  }

  // Below threshold: nearest by substring — longest shared token wins.
  const tokens = query
    .split(/\s+/)
    .filter((token) => token.length >= MIN_TOKEN_LENGTH)
    .sort((a, b) => b.length - a.length);
  for (const token of tokens) {
    const index = lines.findIndex((line) => line.toLowerCase().includes(token));
    if (index !== -1) {
      return { lineNumber: index + 1, text: lines[index] ?? "", similarity: best.similarity };
    }
  }

  return best;
}

/**
 * Build the enriched message returned when `string_replace` cannot find its
 * target text.
 *
 * Message-only by design (ТЗ 2026-09-10): it embeds the file fingerprint, the
 * nearest line, and a concrete next step (`line_replace` + `expectLine`).
 */
export function buildStringNotFoundMessage(
  searchText: string,
  source: string,
  fingerprint?: FileFingerprint,
): string {
  const parts: string[] = [
    `Search string not found: ${JSON.stringify(searchText.slice(0, 120))}`,
  ];

  if (fingerprint) {
    parts.push(
      `file: size=${fingerprint.sizeBytes}B, mtime=${fingerprint.mtime}, sha256=${fingerprint.sha256}`,
    );
  }

  const nearest = findNearestLine(source, searchText);
  if (nearest) {
    parts.push(
      `nearest line ${nearest.lineNumber} (similarity ${nearest.similarity.toFixed(2)}): ${JSON.stringify(nearest.text)}`,
    );
    parts.push(
      `hint: use line_replace startLine=${nearest.lineNumber} endLine=${nearest.lineNumber} (see expectLine=${JSON.stringify(nearest.text.trim())})`,
    );
  } else {
    parts.push("nearest line: none (file has no non-empty lines)");
  }

  return parts.join("\n");
}

/**
 * Emit a structured debug record for a failed `string_replace` when
 * `MCP_DEBUG=1`. Lets a future P1-class mismatch be diagnosed in one call.
 */
export function logStringReplaceFailure(searchText: string, source: string): void {
  if (process.env["MCP_DEBUG"] !== "1") return;
  console.error(
    JSON.stringify({
      event: "string_replace_not_found",
      searchText,
      searchTextCodePoints: Array.from(searchText, (char) => char.codePointAt(0) ?? 0),
      searchTextLength: searchText.length,
      sourceLength: source.length,
      sourceSha256: sha256Short(source),
      includesExact: source.includes(searchText),
    }),
  );
}
