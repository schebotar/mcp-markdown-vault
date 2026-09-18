/**
 * Byte-preserving helpers for YAML frontmatter.
 *
 * Unlike the AST pipeline (remark-stringify) or a full `js-yaml` re-dump,
 * these operate on the raw text so the markdown body is never re-serialized
 * and untouched frontmatter keys keep their order, quoting and comments.
 * Used by `frontmatter_set`.
 */

import yaml from "js-yaml";

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

// ── Preserve-style merge ───────────────────────────────────────────

/** Outcome of a preserve-style merge into the frontmatter block. */
export interface FrontmatterMergeResult {
  /** The full note content with the merged frontmatter block. */
  content: string;
  /** Keys that already existed and were rewritten in place. */
  updatedKeys: string[];
  /** Keys that did not exist and were appended to the block. */
  addedKeys: string[];
  /** Non-fatal notes (e.g. a key whose original quoting could not be kept). */
  warnings: string[];
}

interface KeyBlock {
  key: string;
  /** Index of the key line inside the frontmatter lines array. */
  start: number;
  /** Exclusive end index of the block (indented value lines included). */
  end: number;
  /** Raw text of the value part (after the colon), trailing comment included. */
  valueText: string;
}

/** Strip one layer of matching surrounding quotes from a YAML scalar. */
function unquote(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

/**
 * Parse a top-level `key: value` line. Returns null for indented lines,
 * comments, document markers and plain scalars.
 */
function parseKeyLine(line: string): { key: string; rest: string } | null {
  if (line.length === 0) return null;
  if (/^[ \t]/.test(line)) return null;
  if (line.startsWith("#")) return null;
  if (line === "---" || line === "..." || line.startsWith("--- ")) return null;

  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote !== null) {
      if (ch === "\\" && quote === '"') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ":") {
      const next = line[i + 1];
      if (next !== undefined && next !== " " && next !== "\t") continue;
      const rawKey = line.slice(0, i).trim();
      if (rawKey.length === 0) return null;
      return { key: unquote(rawKey), rest: line.slice(i + 1) };
    }
  }
  return null;
}

/** Split a YAML value from a trailing `# comment` (quote-aware). */
function splitComment(valueText: string): { value: string; comment: string } {
  let quote: string | null = null;
  for (let i = 0; i < valueText.length; i++) {
    const ch = valueText[i]!;
    if (quote !== null) {
      if (ch === "\\" && quote === '"') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || valueText[i - 1] === " " || valueText[i - 1] === "\t")) {
      return { value: valueText.slice(0, i), comment: valueText.slice(i) };
    }
  }
  return { value: valueText, comment: "" };
}

/** Collect top-level key blocks in the frontmatter lines. */
function collectKeyBlocks(lines: string[]): KeyBlock[] {
  const blocks: KeyBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseKeyLine(lines[i]!);
    if (parsed === null) continue;

    let end = i + 1;
    while (end < lines.length) {
      const line = lines[end]!;
      if (line.trim().length === 0) {
        // A blank line belongs to the block only when an indented line follows.
        let k = end;
        while (k < lines.length && lines[k]!.trim().length === 0) k++;
        if (k < lines.length && /^[ \t]/.test(lines[k]!)) {
          end = k;
          continue;
        }
        break;
      }
      if (/^[ \t]/.test(line)) {
        end++;
        continue;
      }
      break;
    }

    blocks.push({ key: parsed.key, start: i, end, valueText: parsed.rest });
    i = end - 1;
  }
  return blocks;
}

/** Quoting style detected on an existing scalar value. */
function quoteStyleOf(valueText: string): "double" | "single" | undefined {
  const trimmed = splitComment(valueText).value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) return "double";
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) return "single";
  return undefined;
}

/** Render a string scalar with an explicit quoting style. */
function quoteScalar(value: string, style: "double" | "single"): string {
  if (style === "double") {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return `'${value.replace(/'/g, "''")}'`;
}

/** Sentinel that js-yaml renders as a plain scalar — locates the value slot. */
const STYLE_SENTINEL = "__style_sentinel__";

/**
 * Dump a single key/value pair, optionally mimicking the quoting style and
 * trailing comment of the line it replaces.
 *
 * `js-yaml`'s own `styles` option only picks the style of strings that would
 * be quoted anyway, so the quoting is applied explicitly here (the probe dump
 * locates where the value starts, keeping any key quoting js-yaml decided on).
 */
function dumpKeyValue(
  key: string,
  value: unknown,
  style?: "double" | "single" | undefined,
  comment?: string | undefined,
): string {
  const base: yaml.DumpOptions = { lineWidth: -1, noRefs: true };
  const dumped = yaml.dump({ [key]: value }, base).trimEnd();

  let rendered = dumped;
  if (style !== undefined && typeof value === "string" && !value.includes("\n")) {
    const probe = yaml.dump({ [key]: STYLE_SENTINEL }, base).trimEnd();
    const at = probe.indexOf(STYLE_SENTINEL);
    if (at >= 0 && !dumped.includes("\n")) {
      rendered = `${probe.slice(0, at)}${quoteScalar(value, style)}`;
    }
  }

  // Only re-attach the trailing comment when the result is a single line.
  if (comment !== undefined && comment.trim().length > 0 && !rendered.includes("\n")) {
    return `${rendered}  ${comment.trim()}`;
  }
  return rendered;
}

/**
 * Merge `patch` into the note's frontmatter while preserving the rest.
 *
 * - Existing keys are rewritten in place, keeping their position and — where
 *   possible — their quoting style and trailing comment.
 * - New keys are appended at the end of the block in patch order.
 * - Every other line of the frontmatter and the whole markdown body stay
 *   byte-for-byte identical.
 */
export function mergeFrontmatterPreservingStyle(
  source: string,
  patch: Record<string, unknown>,
): FrontmatterMergeResult {
  const nl = newlineOf(source);
  const raw = extractFrontmatterRaw(source);
  const warnings: string[] = [];
  const updatedKeys: string[] = [];
  const addedKeys: string[] = [];

  if (raw === undefined) {
    const dumped = yaml.dump(patch, { lineWidth: -1, noRefs: true }).trimEnd();
    addedKeys.push(...Object.keys(patch));
    return {
      content: replaceFrontmatterBlock(source, dumped),
      updatedKeys,
      addedKeys,
      warnings,
    };
  }

  const lines = raw.split(/\r?\n/);
  const blocks = collectKeyBlocks(lines);
  const byKey = new Map<string, KeyBlock>();
  for (const block of blocks) {
    if (!byKey.has(block.key)) byKey.set(block.key, block);
  }

  // Rewrite touched keys in place, walking backwards so earlier indices stay valid.
  const touched = Object.keys(patch)
    .map((key) => byKey.get(key))
    .filter((block): block is KeyBlock => block !== undefined)
    .sort((a, b) => b.start - a.start);

  for (const block of touched) {
    const value = patch[block.key];
    const { comment } = splitComment(block.valueText);
    const style = quoteStyleOf(block.valueText);
    if (style !== undefined && typeof value !== "string") {
      warnings.push(
        `frontmatter key ${JSON.stringify(block.key)} lost its ${style === "double" ? "double" : "single"}-quoted style: the new value is not a string`,
      );
    }
    const replacement = dumpKeyValue(block.key, value, style, comment);
    lines.splice(block.start, block.end - block.start, ...replacement.split("\n"));
    updatedKeys.push(block.key);
  }
  updatedKeys.reverse();

  // Append keys that do not exist yet, in patch order.
  for (const key of Object.keys(patch)) {
    if (byKey.has(key)) continue;
    addedKeys.push(key);
    lines.push(...dumpKeyValue(key, patch[key]).split("\n"));
  }

  return {
    content: replaceFrontmatterBlock(source, lines.join(nl).trimEnd()),
    updatedKeys,
    addedKeys,
    warnings,
  };
}
