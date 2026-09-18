import type { Root } from "mdast";
import { AstNavigator, type HeadingInfo } from "./ast-navigation.js";
import { FuzzyMatcher } from "./fuzzy-match.js";
import { AmbiguousHeadingTargetError, HeadingNotFoundError } from "../domain/errors/index.js";

/** Depth assumed when the caller does not pass `headingDepth`. */
export const DEFAULT_HEADING_DEPTH = 2;

/** Minimum similarity for a suggestion (errors) — looser than for retargeting. */
const SUGGESTION_THRESHOLD = 0.4;

/** Minimum similarity for auto-retargeting an edit to a similar heading. */
const RETARGET_THRESHOLD = 0.6;

/** Outcome of resolving a `heading` (+ optional `headingDepth`) into a target. */
export interface HeadingResolution {
  /** Title text exactly as it appears in the document. */
  title: string;
  /** Depth to apply the edit at. */
  depth: number;
  /**
   * Set when the heading was found at a depth other than the requested /
   * default one, so the caller can report it back to the agent.
   */
  resolvedDepth?: number | undefined;
  /** Human-readable note explaining an automatic depth correction. */
  warning?: string | undefined;
}

function sameTitle(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Format suggestions as `"Title" (headingDepth: N)`, deduplicated, max 5. */
function formatSuggestions(
  query: string,
  headings: readonly HeadingInfo[],
): string[] {
  const matches = FuzzyMatcher.allMatches(
    query,
    headings.map((h) => h.title),
    SUGGESTION_THRESHOLD,
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of matches) {
    const heading = headings.find((h) => h.title === match.match);
    if (!heading) continue;
    const label = `"${heading.title}" (headingDepth: ${heading.depth})`;
    if (seen.has(label)) continue;
    seen.add(label);
    out.push(label);
    if (out.length === 5) break;
  }
  return out;
}

/**
 * Resolve a heading target, tolerating a wrong `headingDepth`.
 *
 * Historically `edit` assumed depth 2 and failed with a bare
 * `HEADING_NOT_FOUND: Heading not found: "X" at depth 2` even when the heading
 * existed at depth 1 — the message never said so. The resolver now:
 *
 * 1. looks for an exact title match at the requested depth;
 * 2. on a miss, looks across ALL depths — a unique match is applied with a
 *    warning and `resolvedDepth`;
 * 3. when several headings share the title, throws an error listing every
 *    candidate with its `headingDepth`;
 * 4. falls back to fuzzy matching (requested depth first, then anywhere);
 * 5. otherwise throws `HEADING_NOT_FOUND` carrying `suggestions`.
 */
export class HeadingResolver {
  static resolve(
    tree: Root,
    heading: string,
    requestedDepth?: number | undefined,
  ): HeadingResolution {
    const all = AstNavigator.findAllHeadings(tree);
    const depth = requestedDepth ?? DEFAULT_HEADING_DEPTH;

    // 1. Exact title match at the requested depth.
    const exactAtDepth = all.filter(
      (h) => h.depth === depth && sameTitle(h.title, heading),
    );
    if (exactAtDepth.length > 1) {
      throw new AmbiguousHeadingTargetError(
        heading,
        depth,
        exactAtDepth,
        formatSuggestions(heading, all),
      );
    }
    if (exactAtDepth.length === 1) {
      return { title: exactAtDepth[0]!.title, depth };
    }

    // 2. Exact title match at another depth.
    const exactElsewhere = all.filter(
      (h) => h.depth !== depth && sameTitle(h.title, heading),
    );
    if (exactElsewhere.length > 1) {
      throw new AmbiguousHeadingTargetError(
        heading,
        depth,
        exactElsewhere,
        formatSuggestions(heading, all),
      );
    }
    if (exactElsewhere.length === 1) {
      const candidate = exactElsewhere[0]!;
      return {
        title: candidate.title,
        depth: candidate.depth,
        resolvedDepth: candidate.depth,
        warning:
          `heading "${heading}" exists at headingDepth ${candidate.depth}, not at the requested depth ${depth}; ` +
          `the edit was applied at depth ${candidate.depth} (pass headingDepth: ${candidate.depth} to silence this warning)`,
      };
    }

    // 3. Fuzzy match, preferring the requested depth.
    const atDepth = all.filter((h) => h.depth === depth);
    const fuzzyAtDepth = FuzzyMatcher.bestMatch(
      heading,
      atDepth.map((h) => h.title),
      RETARGET_THRESHOLD,
    );
    if (fuzzyAtDepth) {
      return { title: fuzzyAtDepth.match, depth };
    }

    // 4. Fuzzy match at any depth — applied only when the title is unique.
    const fuzzyAnywhere = FuzzyMatcher.bestMatch(
      heading,
      all.map((h) => h.title),
      RETARGET_THRESHOLD,
    );
    if (fuzzyAnywhere) {
      const candidates = all.filter((h) => sameTitle(h.title, fuzzyAnywhere.match));
      if (candidates.length === 1) {
        const candidate = candidates[0]!;
        return {
          title: candidate.title,
          depth: candidate.depth,
          resolvedDepth: candidate.depth,
          warning:
            `heading "${heading}" was not found at depth ${depth}; ` +
            `closest match "${candidate.title}" is at headingDepth ${candidate.depth} and was used`,
        };
      }
    }

    // 5. Nothing usable.
    throw new HeadingNotFoundError(heading, depth, {
      suggestions: formatSuggestions(heading, all),
    });
  }
}
