/**
 * Byte-preserving helpers for YAML frontmatter.
 *
 * Unlike the AST pipeline (remark-stringify), these operate on the raw text so
 * the markdown body is never re-serialized or reformatted. Used by
 * `frontmatter_set` to keep the rest of the file byte-for-byte unchanged.
 */

/** Extract the raw YAML between the leading `---` fences, or undefined when absent. */
export function extractFrontmatterRaw(source: string): string | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(source);
  return match ? (match[1] ?? "") : undefined;
}

/** Detect the dominant newline style (defaults to "\n"). */
function newlineOf(source: string): string {
  return source.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Replace (or insert) the leading frontmatter block with `yamlText`, leaving
 * the remainder of the file byte-for-byte unchanged.
 */
export function replaceFrontmatterBlock(source: string, yamlText: string): string {
  const nl = newlineOf(source);
  const existing = /^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/.exec(source);

  if (existing) {
    const body = source.slice(existing[0].length);
    return `---${nl}${yamlText}${nl}---${nl}${body}`;
  }

  if (source.length === 0) {
    return `---${nl}${yamlText}${nl}---${nl}`;
  }

  return `---${nl}${yamlText}${nl}---${nl}${nl}${source}`;
}
