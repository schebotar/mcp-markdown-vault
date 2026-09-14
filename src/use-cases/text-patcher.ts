import type { Root, RootContent } from "mdast";
import { AstNavigator } from "./ast-navigation.js";
import type { PatchOperation } from "./ast-patcher.js";
import type { MarkdownPipeline } from "./markdown-pipeline.js";
import { HeadingNotFoundError, BlockNotFoundError } from "../domain/errors/index.js";

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

/** Serialize only the inserted fragment; an empty fragment stays empty. */
function serializeFragment(content: string, pipeline: MarkdownPipeline): string {
  if (typeof content !== "string" || content.trim().length === 0) return "";
  const nodes = pipeline.parse(content).children;
  const subtree: Root = { type: "root", children: nodes };
  return pipeline.stringify(subtree).trim();
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

/**
 * Byte-preserving patcher for heading/block targets.
 *
 * Only the target region of the ORIGINAL text is replaced; everything else —
 * including other sections, dash bullets, tables and `_` escapes — is
 * preserved byte-for-byte. Only the inserted fragment is serialized.
 *
 * Falls back (returns undefined) when node offsets are unavailable, so the
 * caller can use the classic AST re-serialization path instead.
 * Document targets are intentionally left to {@link AstPatcher}.
 */
export class TextPatcher {
  static apply(
    source: string,
    tree: Root,
    op: PatchOperation,
    pipeline: MarkdownPipeline,
  ): string | undefined {
    if (op.target === "document") return undefined;

    const fragment = serializeFragment(op.content, pipeline);

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
}
