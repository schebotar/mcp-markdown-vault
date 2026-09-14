import yaml from "js-yaml";
import type { IFileSystemAdapter } from "../domain/interfaces/file-system-adapter.js";
import type { IDiffService } from "../domain/interfaces/diff-service.js";
import type { IMarkdownRepository } from "../domain/interfaces/markdown-repository.js";
import { BatchLimitExceededError, AmbiguousHeadingTargetError, InvalidArgumentError, InvalidFrontmatterYamlError, FreeformEditError } from "../domain/errors/index.js";
import type { MarkdownPipeline } from "./markdown-pipeline.js";
import { AstNavigator } from "./ast-navigation.js";
import { AstPatcher } from "./ast-patcher.js";
import { FuzzyMatcher } from "./fuzzy-match.js";
import { FreeformEditor } from "./freeform-editor.js";
import { DryRunEditor } from "./dry-run-edit.js";
import { parseFrontmatterPayload } from "./frontmatter.js";
import { fingerprintNote } from "./file-fingerprint.js";
import { buildStringNotFoundMessage, logStringReplaceFailure } from "./string-not-found.js";
import { extractFrontmatterRaw, replaceFrontmatterBlock } from "./frontmatter-surgery.js";

const MAX_OPERATIONS = 50;

/** Pojedyncza operacja edycji w batch. */
export interface EditOperation {
  path: string;
  operation: "append" | "prepend" | "replace" | "delete" | "line_replace" | "string_replace" | "frontmatter_set";
  content: string;
  heading?: string | undefined;
  headingDepth?: number | undefined;
  blockId?: string | undefined;
  startLine?: number | undefined;
  endLine?: number | undefined;
  expectLine?: string | undefined;
  searchText?: string | undefined;
  replaceAll?: boolean | undefined;
  replaceMode?: "body" | "section" | undefined;
}

/** Batch edit request. */
export interface BatchEditRequest {
  operations: EditOperation[];
  dryRun?: boolean | undefined;
}

/** Result of a single operation. */
export interface BatchEditResult {
  index: number;
  path: string;
  action: string;
  status: "success" | "error";
  diff?: string | undefined;
  error?: string | undefined;
  changed?: boolean | undefined;
  warnings?: string[] | undefined;
}

/** Batch edit response. */
export interface BatchEditResponse {
  results: BatchEditResult[];
  totalRequested: number;
  totalSucceeded: number;
  totalFailed: number;
  stoppedAtIndex?: number | undefined;
}

/**
 * Service that executes multiple edit operations sequentially.
 * Stops on first error.
 * Delegates to the same use cases as single edits.
 */
export class BatchEditService {
  private readonly dryRunEditor: DryRunEditor;

  constructor(
    private readonly fsAdapter: IFileSystemAdapter,
    private readonly pipeline: MarkdownPipeline,
    diffService: IDiffService,
    _markdownRepo: IMarkdownRepository,
  ) {
    this.dryRunEditor = new DryRunEditor(fsAdapter, diffService);
  }

  /**
   * Validates that an operation is well-formed BEFORE any file I/O occurs.
   *
   * Structural problems (missing required field, invalid JSON payload) reject
   * the whole batch request up front, so a malformed operation can never
   * silently write to disk. Runtime problems (file missing, search string not
   * found) are handled per-operation with `stoppedAtIndex`.
   *
   * `content` is required for every operation EXCEPT `delete`. An empty string
   * is a legitimate value (e.g. removing a block via string_replace).
   */
  private static assertValidOperation(op: EditOperation): void {
    if (typeof op.path !== "string" || op.path.length === 0) {
      throw new InvalidArgumentError("path");
    }
    if (op.operation === "delete") {
      return;
    }
    if (typeof op.content !== "string") {
      throw new InvalidArgumentError("content");
    }
    if (op.operation === "string_replace") {
      if (typeof op.searchText !== "string" || op.searchText.length === 0) {
        throw new InvalidArgumentError("searchText");
      }
    } else if (op.operation === "line_replace") {
      if (
        typeof op.startLine !== "number"
        || typeof op.endLine !== "number"
      ) {
        throw new InvalidArgumentError("startLine/endLine");
      }
    } else if (op.operation === "frontmatter_set") {
      // Throws InvalidFrontmatterPayloadError when content is not valid JSON.
      parseFrontmatterPayload(op.content);
    }
  }

  async execute(request: BatchEditRequest): Promise<BatchEditResponse> {
    const { operations, dryRun } = request;

    if (operations.length > MAX_OPERATIONS) {
      throw new BatchLimitExceededError(operations.length, MAX_OPERATIONS);
    }

    if (operations.length === 0) {
      return {
        results: [],
        totalRequested: 0,
        totalSucceeded: 0,
        totalFailed: 0,
      };
    }

    // Reject the whole request (no I/O) if any operation is structurally
    // malformed — e.g. a string_replace missing `content` must never write
    // the literal string "undefined" to disk.
    for (const op of operations) {
      BatchEditService.assertValidOperation(op);
    }

    const results: BatchEditResult[] = [];
    let totalSucceeded = 0;
    let totalFailed = 0;
    let stoppedAtIndex: number | undefined;

    for (let i = 0; i < operations.length; i++) {
      const op = operations[i]!;
      try {
        const editResult = await this.executeSingle(op, dryRun ?? false);
        results.push({
          index: i,
          path: op.path,
          action: op.operation,
          status: "success",
          diff: editResult.diff,
          changed: editResult.changed,
        });
        totalSucceeded++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({
          index: i,
          path: op.path,
          action: op.operation,
          status: "error",
          error: message,
        });
        totalFailed++;
        stoppedAtIndex = i;
        break;
      }
    }

    return {
      results,
      totalRequested: operations.length,
      totalSucceeded,
      totalFailed,
      stoppedAtIndex,
    };
  }

  // Execute a single operation — delegates to existing use cases
  private async executeSingle(
    op: EditOperation,
    dryRun: boolean,
  ): Promise<{ message: string; diff?: string | undefined; changed?: boolean | undefined }> {
    const source = await this.fsAdapter.readNote(op.path);

    const withChanged = async (newContent: string, label: string) => {
      const editResult = await this.dryRunEditor.execute({
        path: op.path,
        oldContent: source,
        newContent,
        dryRun,
        operationLabel: label,
      });
      return { ...editResult, changed: source !== newContent };
    };

    // ── Freeform: line_replace ────────────────────────────────────
    if (op.operation === "line_replace") {
      if (op.startLine === undefined || op.endLine === undefined) {
        throw new Error("startLine and endLine are required for line_replace");
      }
      if (op.expectLine !== undefined) {
        FreeformEditor.assertLine(source, op.startLine, op.expectLine);
      }
      const newContent = FreeformEditor.lineReplace(
        source, op.startLine, op.endLine, op.content,
      );
      return withChanged(newContent, `line_replace lines ${op.startLine}-${op.endLine}`);
    }

    // ── Freeform: string_replace ─────────────────────────────────
    if (op.operation === "string_replace") {
      if (!op.searchText) {
        throw new Error("searchText is required for string_replace");
      }
      if (!source.includes(op.searchText)) {
        logStringReplaceFailure(op.searchText, source);
        const fingerprint = await fingerprintNote(this.fsAdapter, op.path, source)
          .catch(() => undefined);
        throw new FreeformEditError(
          buildStringNotFoundMessage(op.searchText, source, fingerprint),
        );
      }
      const newContent = FreeformEditor.stringReplace(
        source, op.searchText, op.content, op.replaceAll ?? false,
      );
      return withChanged(newContent, "string_replace");
    }

    // ── Frontmatter ──────────────────────────────────────────────
    if (op.operation === "frontmatter_set") {
      const data = parseFrontmatterPayload(op.content);
      const rawFrontmatter = extractFrontmatterRaw(source);
      let existing: Record<string, unknown> = {};
      if (rawFrontmatter !== undefined) {
        try {
          const loaded = yaml.load(rawFrontmatter);
          if (typeof loaded === "object" && loaded !== null) {
            existing = loaded as Record<string, unknown>;
          }
        } catch (err) {
          throw new InvalidFrontmatterYamlError(op.path, err);
        }
      }
      const merged = Object.assign({}, existing, data);
      const newContent = replaceFrontmatterBlock(source, yaml.dump(merged).trimEnd());
      return withChanged(newContent, "frontmatter_set");
    }

    // ── Operacje AST (append / prepend / replace / delete) ──────────
    const tree = this.pipeline.parse(source);

    let target: Parameters<typeof AstPatcher.apply>[1]["target"];
    if (op.blockId) {
      target = { blockId: op.blockId };
    } else if (op.heading) {
      const depth = op.headingDepth ?? 2;
      const allHeadings = AstNavigator.findAllHeadings(tree);
      const candidates = allHeadings
        .filter((h) => h.depth === depth)
        .map((h) => h.title);
      if (candidates.length > 0) {
        const exactMatches = AstNavigator.findAllMatchingHeadings(tree, op.heading, depth);
        if (exactMatches.length > 1) {
          throw new AmbiguousHeadingTargetError(op.heading, depth, exactMatches);
        }
        const matched = FuzzyMatcher.bestMatch(op.heading, candidates, 0.6);
        target = matched
          ? { heading: matched.match, depth }
          : { heading: op.heading, depth };
      } else {
        target = { heading: op.heading, depth };
      }
    } else {
      target = "document";
    }

    AstPatcher.apply(tree, { type: op.operation, target, content: op.content, replaceMode: op.replaceMode }, this.pipeline);
    const newContent = this.pipeline.stringify(tree);

    return withChanged(newContent, op.operation);
  }
}
