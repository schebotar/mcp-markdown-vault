const HTML_ENTITY = /&#x?[0-9a-fA-F]+;|&[a-zA-Z][a-zA-Z0-9]*;/;
const LITERAL_BACKSLASH_N = /\\n/;

/**
 * Heuristic checks for "model escaping" artifacts in content about to be
 * written. Returns human-readable warnings (never blocks the write): dash /
 * underscore escapes are sometimes legitimate, so this is advisory only.
 */
export function checkContentSanity(content: string): string[] {
  const warnings: string[] = [];

  if (LITERAL_BACKSLASH_N.test(content)) {
    warnings.push("content contains a literal \\n sequence; did you mean a real newline?");
  }

  if (HTML_ENTITY.test(content)) {
    warnings.push("content contains HTML entities (e.g. &#x6E;) that may be escaping artifacts");
  }

  const withoutCode = content
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]*`/g, "");
  if (/\\_/.test(withoutCode)) {
    warnings.push("content contains escaped underscores (\\_) outside code blocks");
  }

  return warnings;
}
