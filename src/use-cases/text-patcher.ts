import type { Root, RootContent } from "mdast";
import { AstNavigator } from "./ast-navigation.js";
import type { PatchOperation } from "./ast-patcher.js";
import { HeadingNotFoundError, BlockNotFoundError, UnsafeDeleteTargetError } from "../domain/errors/index.js";

/** Character offsets of a node within the original source. */
interface Offsets {
  start: number;
  end: number;
}

function nodeOffsets(node: RootContent): Offsets | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (typeof start !== "number" || typeof end !== "number") return null;
  return { start, end };
}

/**
 * Normalize the insertable payload WITHOUT re-serializing markdown.
 *
 * Only surrounding blank lines are trimmed — the payload itself is inserted
 * verbatim, so `-`, `_`, `[[...]]`, `*` and table pipes survive untouched.
 * An empty payload stays empty (the operation becomes a no-op for the target).
 */
function asInsert(payload: string): string {
  if (typeof payload !== "string") return "";
  return payload.replace(/^\n+/, "").replace(/[ \t]+$/, "").replace(/\n+$/, "");
}

/** Join head + replacement + tail, collapsing blank-line runs at the seams. */
function splice(
  source: string,
  start: number,
  end: number,
  replacement: string,
): string {
  const head = source.slice(0, start).replace(/\n+$/, "");
  const mid = replacement.replace(/^\n+/, "").replace(/\n+$/, "");
  const tail = source.slice(end).replace(/^\n+/, "");

  let out = head;
  if (mid.length > 0) {
    if (out.length > 0) out += "\n\n";
    out += mid;
  }
  if (tail.length > 0) {
    if (out.length > 0) out += "\n\n";
    out += tail;
  } else if (out.length > 0) {
    out += "\n";
  }
  return out;
}

/** The leading `---` YAML block plus its newline, or "" when absent. */
function frontmatterHead(source: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(source);
  return match ? match[0] : "";
}

/**
 * Byte-preserving patcher.
 *
 * Only the target region of the ORIGINAL text is replaced; everything else —
 * including other sections, dash bullets, tables and `_` escapes — is
 * preserved byte-for-byte. The inserted `content` is written verbatim, never
 * passed through remark-stringify (which would rewrite `-` into `*`, escape
 * `_` and pad table rows).
 *
 * Heading/block targets use {@link TextPatcher.apply}; whole-document targets
 * use {@link TextPatcher.applyDocument}. Callers that explicitly want the
 * canonical form can set `normalize: true` and fall back to `AstPatcher`.
 */
export class TextPatcher {
  /**
   * Patch a heading or block target by splicing the raw source text.
   *
   * Returns `undefined` when node offsets are unavailable, so the caller can
   * fall back to the classic AST re-serialization path instead.
   */
  static apply(
    source: string,
    tree: Root,
    op: PatchOperation,
  ): string | undefined {
    if (op.target === "document") return undefined;

    const fragment = asInsert(op.content);

    if ("heading" in op.target) {
      const range = AstNavigator.getHeadingRange(
        tree,
        op.target.heading,
        op.target.depth,
      );
      if (!range) {
        throw new HeadingNotFoundError(op.target.heading, op.target.depth);
      }
      const startNode = tree.children[range.startIndex];
      const endNode = tree.children[range.endIndex - 1];
      if (!startNode || !endNode) {
        throw new HeadingNotFoundError(op.target.heading, op.target.depth);
      }

      const startOff = nodeOffsets(startNode);
      const endOff = nodeOffsets(endNode);
      if (!startOff || !endOff) return undefined;

      const sectionText = source.slice(startOff.start, endOff.end);
      const headingText = source.slice(startOff.start, startOff.end);
      const bodyText = source.slice(startOff.end, endOff.end);

      let replacement: string;
      switch (op.type) {
        case "append":
          replacement = fragment.length > 0 ? `${sectionText}\n\n${fragment}` : sectionText;
          break;
        case "prepend":
          replacement = fragment.length > 0
            ? `${headingText}\n\n${fragment}${bodyText}`
            : `${headingText}${bodyText}`;
          break;
        case "replace":
          replacement = op.replaceMode === "section"
            ? fragment
            : (fragment.length > 0 ? `${headingText}\n\n${fragment}` : headingText);
          break;
        case "delete":
          replacement = "";
          break;
      }
      return splice(source, startOff.start, endOff.end, replacement);
    }

    const loc = AstNavigator.findBlockById(tree, op.target.blockId);
    if (!loc) {
      throw new BlockNotFoundError(op.target.blockId);
    }
    const off = nodeOffsets(loc.node);
    if (!off) return undefined;
    const nodeText = source.slice(off.start, off.end);

    let replacement: string;
    switch (op.type) {
      case "append":
        replacement = fragment.length > 0 ? `${nodeText}\n\n${fragment}` : nodeText;
        break;
      case "prepend":
        replacement = fragment.length > 0 ? `${fragment}\n\n${nodeText}` : nodeText;
        break;
      case "replace":
        replacement = fragment;
        break;
      case "delete":
        replacement = "";
        break;
    }
    return splice(source, off.start, off.end, replacement);
  }

  /**
   * Patch a whole-document target (no `heading`, no `blockId`) without
   * re-serializing the file.
   *
   * - `append`  — append `content` at the end of the file.
   * - `prepend` — insert `content` at the top, but AFTER the YAML frontmatter,
   *               which must stay the first block.
   * - `replace` — replace the document BODY (frontmatter preserved) with
   *               `content`; the body is not re-serialized.
   * - `delete`  — rejected: use `vault delete` to remove files.
   */
  static applyDocument(source: string, op: PatchOperation): string {
    if (op.type === "delete") {
      throw new UnsafeDeleteTargetError(
        "Cannot delete entire document via edit.delete — use vault.delete to remove files",
      );
    }

    const fragment = asInsert(op.content);
    const head = frontmatterHead(source);
    const body = source.slice(head.length);

    switch (op.type) {
      case "append": {
        if (fragment.length === 0) return source;
        const trimmedEnd = source.replace(/\n+$/, "");
        const trailing = source.slice(trimmedEnd.length);
        const separator = trailing.length >= 2 ? trailing : "\n\n";
        return `${trimmedEnd}${separator}${fragment}\n`;
      }
      case "prepend": {
        const leading = /^\n+/.exec(body)?.[0] ?? "";
        const rest = body.slice(leading.length);
        if (fragment.length === 0) return source;
        if (rest.length === 0) {
          return head.length > 0 ? `${head}${fragment}\n` : `${fragment}\n`;
        }
        const separator = leading.length >= 2 ? leading : "\n\n";
        return `${head}${fragment}${separator}${rest}`;
      }
      case "replace": {
        if (fragment.length === 0) return head;
        return head.length > 0 ? `${head}\n${fragment}\n` : `${fragment}\n`;
      }
    }
  }
}
