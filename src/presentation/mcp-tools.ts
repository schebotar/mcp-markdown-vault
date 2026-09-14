import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerOptions } from "@modelcontextprotocol/sdk/server/index.js";
import yaml from "js-yaml";
import { z } from "zod";
import type { IFileSystemAdapter } from "../domain/interfaces/file-system-adapter.js";
import type { IEmbeddingProvider, IVectorStore } from "../domain/interfaces/index.js";
import { WorkflowStateMachine } from "../use-cases/workflow-state.js";
import { HintsEngine, type ToolName } from "../use-cases/hints.js";
import { MarkdownPipeline } from "../use-cases/markdown-pipeline.js";
import { AstNavigator } from "../use-cases/ast-navigation.js";
import { AstPatcher } from "../use-cases/ast-patcher.js";
import type { PatchOperation } from "../use-cases/ast-patcher.js";
import { TextPatcher } from "../use-cases/text-patcher.js";
import { FragmentRetriever } from "../use-cases/fragment-retrieval.js";
import { FuzzyMatcher } from "../use-cases/fuzzy-match.js";
import { VaultSearcher } from "../use-cases/vault-search.js";
import { HybridSearcher } from "../use-cases/hybrid-search.js";
import { FreeformEditor } from "../use-cases/freeform-editor.js";
import { ReadByHeadingUseCase } from "../use-cases/read-by-heading.js";
import { BulkReadUseCase } from "../use-cases/bulk-read.js";
import { GetFrontmatterUseCase, parseFrontmatterPayload } from "../use-cases/frontmatter.js";
import { UpdateFileUseCase } from "../use-cases/update-file.js";
import { DryRunEditor } from "../use-cases/dry-run-edit.js";
import { CreateFromTemplateUseCase } from "../use-cases/create-from-template.js";
import { BatchEditService, type EditOperation } from "../use-cases/batch-edit.js";
import { VaultOverviewService } from "../use-cases/vault-overview.js";
import { BacklinkIndexService } from "../use-cases/backlink-index.js";
import { VaultIndexer } from "../use-cases/vault-indexer.js";
import { MarkdownFileRepository } from "../infrastructure/markdown-file-repository.js";
import { RegexTemplateEngine } from "../infrastructure/regex-template-engine.js";
import { UnifiedDiffService } from "../infrastructure/diff-service.js";
import { DomainError, InvalidArgumentError, OutlineLimitExceededError, AmbiguousHeadingTargetError, InvalidFrontmatterYamlError, PathIsDirectoryError, FreeformEditError, NoteNotFoundError } from "../domain/errors/index.js";
import { OverviewManager } from "../use-cases/overview-manager.js";
import { VaultStatsComposer } from "../use-cases/vault-stats.js";
import { VaultOverviewResourceComposer } from "../use-cases/vault-resource-overview.js";
import { fingerprintNote } from "../use-cases/file-fingerprint.js";
import { buildStringNotFoundMessage, logStringReplaceFailure } from "../use-cases/string-not-found.js";
import { extractFrontmatterRaw, replaceFrontmatterBlock } from "../use-cases/frontmatter-surgery.js";
import { matchGlob } from "../use-cases/glob.js";
import { checkContentSanity } from "../use-cases/content-sanity.js";
import { NormalizeLinksUseCase } from "../use-cases/normalize-links.js";
import { SelftestUseCase } from "../use-cases/selftest.js";

export interface McpDependencies {
  fsAdapter: IFileSystemAdapter;
  vectorStore: IVectorStore;
  embedder: IEmbeddingProvider;
  workflow: WorkflowStateMachine;
  vaultRoot: string;
  backlinkIndex?: BacklinkIndexService | undefined;
  indexer?: VaultIndexer | undefined;
  instructions?: string | undefined;
  getVaultScope?: (() => string) | undefined;
}

/**
 * Creates and configures the MCP server with all 5 semantic tools.
 */
export function createMcpServer(deps: McpDependencies): McpServer {
  let serverOptions: ServerOptions | undefined;
  if (deps.instructions) {
    serverOptions = { instructions: deps.instructions };
  }
  const server = new McpServer(
    { name: "markdown-vault-mcp", version: "0.1.0" },
    serverOptions,
  );

  const pipeline = new MarkdownPipeline();
  const retriever = new FragmentRetriever(pipeline);

  const statsComposerDeps: ConstructorParameters<typeof VaultStatsComposer>[0] = {
    fsAdapter: deps.fsAdapter,
    embedder: deps.embedder,
  };
  if (deps.indexer) {
    statsComposerDeps.indexer = deps.indexer;
  }
  const statsComposer = new VaultStatsComposer(statsComposerDeps);
  const overviewComposer = new VaultOverviewResourceComposer({
    fsAdapter: deps.fsAdapter,
    statsComposer,
  });

  server.registerResource(
    "vault-overview",
    "vault://overview",
    { title: "Vault Overview", description: "Complete vault context: live stats, overview, and conventions (frontmatter schema, tags, naming).", mimeType: "text/markdown" },
    async () => {
      const text = await overviewComposer.compose();
      return { contents: [{ uri: "vault://overview", text, mimeType: "text/markdown" }] };
    },
  );

  server.registerResource(
    "vault-stats",
    "vault://stats",
    { title: "Vault Stats", description: "Live vault statistics as JSON.", mimeType: "application/json" },
    async () => {
      const stats = await statsComposer.computeStats();
      return { contents: [{ uri: "vault://stats", text: JSON.stringify(stats), mimeType: "application/json" }] };
    },
  );

  let firstToolCall = true;
  const getVaultScope = deps.getVaultScope ?? (() => "general markdown notes vault");
  const vaultScope = getVaultScope();
  const vaultOrientationHint = "Read vault://overview resource for full vault context, search strategy, workflow guidance, and conventions.";

  // ── vault tool ──────────────────────────────────────────────────

  server.registerTool("vault", {
    title: "Vault",
    description:
      `Manage vault notes. Vault scope: ${vaultScope}. Actions: list (browse notes), read (full note), create/update/delete (whole-file writes), stat (metadata), create_from_template (scaffold from template). For search strategy and conventions, read vault://overview.`,
    inputSchema: {
      action: z.enum(["list", "read", "create", "update", "delete", "stat", "create_from_template"]),
      path: z.string().optional(),
      directory: z.string().optional(),
      content: z.string().optional(),
      templatePath: z.string().optional().describe("Source template file path (for create_from_template)."),
      variables: z.record(z.string(), z.string()).optional().describe("Key-value variables to inject into template placeholders (for create_from_template)."),
    },
  }, async ({ action, path, directory, content, templatePath, variables }) => {
    return wrapTool(deps.workflow, "vault", takePrimingContext(), async () => {
      switch (action) {
        case "list": {
          const notes = await deps.fsAdapter.listNotes(directory);
          return notes;
        }
        case "read": {
          if (!path) throw new InvalidArgumentError("path");
          const noteContent = await deps.fsAdapter.readNote(path);
          return noteContent;
        }
        case "create": {
          if (!path) throw new InvalidArgumentError("path");
          if (!content) throw new InvalidArgumentError("content");
          await deps.fsAdapter.writeNote(path, content);
          deps.backlinkIndex?.updateFile(path, content);
          deps.indexer?.indexFile(path).catch(() => {/* background */});
          const warnings = checkContentSanity(content);
          return warnings.length > 0
            ? { message: `Note created: ${path}`, warnings }
            : `Note created: ${path}`;
        }
        case "update": {
          if (!path) throw new InvalidArgumentError("path");
          if (!content) throw new InvalidArgumentError("content");
          const useCase = new UpdateFileUseCase(deps.fsAdapter);
          const result = await useCase.execute({ path, content });
          deps.backlinkIndex?.updateFile(path, content);
          deps.indexer?.indexFile(path).catch(() => {/* background */});
          const warnings = checkContentSanity(content);
          return warnings.length > 0
            ? { message: result.message, warnings }
            : result.message;
        }
        case "delete": {
          if (!path) throw new InvalidArgumentError("path");
          await deps.fsAdapter.deleteNote(path);
          deps.backlinkIndex?.removeFile(path);
          deps.indexer?.removeFile(path).catch(() => {/* background */});
          return `Note deleted: ${path}`;
        }
        case "stat": {
          if (!path) throw new InvalidArgumentError("path");
          const stat = await deps.fsAdapter.stat(path);
          return stat;
        }
        case "create_from_template": {
          if (!path) throw new InvalidArgumentError("path");
          if (!templatePath) throw new InvalidArgumentError("templatePath");
          const engine = new RegexTemplateEngine();
          const useCase = new CreateFromTemplateUseCase(deps.fsAdapter, engine);
          const result = await useCase.execute({
            templatePath,
            destinationPath: path,
            variables,
          });
          // Update indexes after template creation
          const created = await deps.fsAdapter.readNote(path);
          deps.backlinkIndex?.updateFile(path, created);
          deps.indexer?.indexFile(path).catch(() => {/* background */});
          return result.message;
        }
        default:
          throw new InvalidArgumentError("action");
      }
    });
  });

  // ── edit tool ───────────────────────────────────────────────────

  server.registerTool("edit", {
    title: "Edit",
    description:
      `Edit notes safely. Vault scope: ${vaultScope}. Supports AST edits by heading/block ID, freeform line/string replacement, frontmatter_set metadata merges, batch operations (max 50), and dryRun=true unified diff previews. Read vault://overview for editing strategy and conventions.\n\nTIPS: Always use dryRun=true before destructive operations (delete, replace). Use bulk_read for reading 2+ files. Use view.outline before heading-specific edits when unsure of heading names. string_replace requires exact literal match including whitespace/newlines. Write wiki-links unescaped as [[path]] (not \\[[path]]).`,
    inputSchema: {
      path: z.string().optional().describe("Note path (required for single edit)."),
      operation: z.enum(["append", "prepend", "replace", "delete", "line_replace", "string_replace", "frontmatter_set"]).optional().describe("Edit operation (required for single edit). 'delete' removes the full heading section including child headings. 'replace' by default replaces only the body under the heading (heading node preserved). Use replaceMode='section' to replace the heading and all its content."),
      content: z.string().optional().describe("Content to apply (required for single edit, ignored for delete)."),
      heading: z.string().optional(),
      headingDepth: z.number().optional(),
      replaceMode: z.enum(["body", "section"]).optional().describe("For replace operation: 'body' (default) preserves the heading node and replaces only body content. 'section' replaces the entire heading section including the heading node and all child headings."),
      blockId: z.string().optional(),
      startLine: z.number().optional(),
      endLine: z.number().optional(),
      searchText: z.string().optional(),
      replaceAll: z.boolean().optional(),
      expectLine: z.string().optional().describe("For line_replace: verify that startLine contains this text (after trim) before replacing; on mismatch the error reports the actual line content."),
      dryRun: z.boolean().optional().describe("If true, returns a preview of changes as a unified diff without saving to disk."),
      returnContent: z.enum(["none", "section", "file"]).optional().describe("When set to 'section' or 'file', the response includes the modified content (max 8KB). Defaults to 'none'."),
      operations: z.array(z.object({
        path: z.string(),
        operation: z.enum(["append", "prepend", "replace", "delete", "line_replace", "string_replace", "frontmatter_set"]),
        content: z.string().optional(),
        heading: z.string().optional(),
        headingDepth: z.number().optional(),
        replaceMode: z.enum(["body", "section"]).optional(),
        blockId: z.string().optional(),
        startLine: z.number().optional(),
        endLine: z.number().optional(),
        searchText: z.string().optional(),
        replaceAll: z.boolean().optional(),
        expectLine: z.string().optional(),
      })).optional().describe("For batch mode: array of edit operations (max 50). Executed sequentially, stops on first error."),
    },
  }, async ({ path: notePath, operation, content, heading, headingDepth, replaceMode, blockId, startLine, endLine, searchText, replaceAll, expectLine, dryRun, returnContent, operations }) => {
    return wrapTool(deps.workflow, "edit", takePrimingContext(), async () => {
      // Helper: update indexes after file write
      // Backlinks synchronously (required for consistency), vectors in background
      const syncIndexes = async (filePath: string): Promise<void> => {
        const updated = await deps.fsAdapter.readNote(filePath);
        deps.backlinkIndex?.updateFile(filePath, updated);
        deps.indexer?.indexFile(filePath).catch(() => {/* background */});
      };

      // ── Batch mode ─────────────────────────────────────────────
      if (operations && operations.length > 0) {
        const diffService = new UnifiedDiffService();
        const repo = new MarkdownFileRepository(deps.fsAdapter, pipeline);
        const batchService = new BatchEditService(deps.fsAdapter, pipeline, diffService, repo);
        const batchResult = await batchService.execute({
          operations: operations as EditOperation[],
          dryRun,
        });
        // Update indexes for each successfully edited file (not dryRun)
        if (!dryRun) {
          const edited = new Set<string>();
          for (const op of operations as EditOperation[]) {
            edited.add(op.path);
          }
          for (const p of edited) {
            await syncIndexes(p);
          }
        }
        return batchResult;
      }

      // ── Single mode — validate required fields ─────────────
      if (!notePath) throw new InvalidArgumentError("path");
      if (!operation) throw new InvalidArgumentError("operation");
      if (content === undefined && operation !== "delete") throw new InvalidArgumentError("content");

      const source = await deps.fsAdapter.readNote(notePath);
      const contentWarnings =
        content !== undefined && operation !== "frontmatter_set" && operation !== "delete"
          ? checkContentSanity(content)
          : [];
      const diffService = new UnifiedDiffService();
      const dryRunEditor = new DryRunEditor(deps.fsAdapter, diffService);

      const SIZE_GUARD = 8192;

      const enrichAndFinalize = async (
        editResult: import("../use-cases/dry-run-edit.js").DryRunEditResponse,
        newContent: string,
        targetResolved?: string | undefined,
      ): Promise<import("../use-cases/dry-run-edit.js").DryRunEditResponse> => {
        if (!(dryRun ?? false)) {
          await syncIndexes(notePath);
        }
        const enriched: import("../use-cases/dry-run-edit.js").DryRunEditResponse = {
          ...editResult,
          changed: source !== newContent,
          operation,
          path: notePath,
          ...(targetResolved !== undefined ? { targetResolved } : {}),
        };
        if (contentWarnings.length > 0) {
          enriched.warnings = contentWarnings;
        }
        const rc = returnContent ?? "none";
        if (rc === "file") {
          const fileContent = dryRun ? newContent : await deps.fsAdapter.readNote(notePath);
          if (fileContent.length > SIZE_GUARD) {
            enriched.truncated = true;
            enriched.fileContent = fileContent.slice(0, SIZE_GUARD);
          } else {
            enriched.fileContent = fileContent;
          }
        } else if (rc === "section") {
          const sectionContent = newContent;
          if (sectionContent.length > SIZE_GUARD) {
            enriched.truncated = true;
            enriched.modifiedSection = sectionContent.slice(0, SIZE_GUARD);
          } else {
            enriched.modifiedSection = sectionContent;
          }
        }
        return enriched;
      };

      // ── Freeform operations ─────────────────────────────────────
      if (operation === "line_replace") {
        if (startLine === undefined || endLine === undefined) {
          throw new InvalidArgumentError("startLine/endLine");
        }
        if (content === undefined) throw new InvalidArgumentError("content");
        if (expectLine !== undefined) {
          FreeformEditor.assertLine(source, startLine, expectLine);
        }
        const newContent = FreeformEditor.lineReplace(source, startLine, endLine, content);
        const result = await dryRunEditor.execute({
          path: notePath,
          oldContent: source,
          newContent,
          dryRun: dryRun ?? false,
          operationLabel: `line_replace lines ${startLine}-${endLine}`,
        });
        return enrichAndFinalize(result, newContent);
      }

      if (operation === "string_replace") {
        if (!searchText) {
          throw new InvalidArgumentError("searchText");
        }
        if (content === undefined) throw new InvalidArgumentError("content");
        if (!source.includes(searchText)) {
          logStringReplaceFailure(searchText, source);
          const fingerprint = await fingerprintNote(deps.fsAdapter, notePath, source)
            .catch(() => undefined);
          throw new FreeformEditError(
            buildStringNotFoundMessage(searchText, source, fingerprint),
          );
        }
        const newContent = FreeformEditor.stringReplace(source, searchText, content, replaceAll ?? false);
        const result = await dryRunEditor.execute({
          path: notePath,
          oldContent: source,
          newContent,
          dryRun: dryRun ?? false,
          operationLabel: "string_replace",
        });
        return enrichAndFinalize(result, newContent);
      }

      // ── Frontmatter operation ──────────────────────────────────
      if (operation === "frontmatter_set") {
        if (content === undefined) throw new InvalidArgumentError("content");
        const parsed = parseFrontmatterPayload(content);

        // Byte-preserving: only the frontmatter block is rewritten; the body
        // is never passed through remark-stringify.
        const rawFrontmatter = extractFrontmatterRaw(source);
        let existing: Record<string, unknown> = {};
        if (rawFrontmatter !== undefined) {
          try {
            const loaded = yaml.load(rawFrontmatter);
            if (typeof loaded === "object" && loaded !== null) {
              existing = loaded as Record<string, unknown>;
            }
          } catch (err) {
            throw new InvalidFrontmatterYamlError(notePath, err);
          }
        }
        const mergedFrontmatter = Object.assign({}, existing, parsed);
        const newContent = replaceFrontmatterBlock(
          source,
          yaml.dump(mergedFrontmatter).trimEnd(),
        );

        const result = await dryRunEditor.execute({
          path: notePath,
          oldContent: source,
          newContent,
          dryRun: dryRun ?? false,
          operationLabel: "frontmatter_set",
        });
        return enrichAndFinalize(result, newContent);
      }

      // ── AST operations ──────────────────────────────────────────
      const tree = pipeline.parse(source);

      // Build target
      let target: Parameters<typeof AstPatcher.apply>[1]["target"];
      let targetResolved: string | undefined;

      if (blockId) {
        target = { blockId };
      } else if (heading) {
        const depth = headingDepth ?? 2;

        // Check for exact duplicates first — throw before fuzzy matching
        const allHeadings = AstNavigator.findAllHeadings(tree);
        const exactDuplicates = AstNavigator.findAllMatchingHeadings(tree, heading, depth);
        if (exactDuplicates.length > 1) {
          throw new AmbiguousHeadingTargetError(heading, depth, exactDuplicates);
        }

        // Fuzzy match the heading title
        const candidates = allHeadings
          .filter((h) => h.depth === depth)
          .map((h) => h.title);

        if (candidates.length > 0) {
          const matched = FuzzyMatcher.bestMatch(heading, candidates, 0.6);
          if (matched) {
            target = { heading: matched.match, depth };
            targetResolved = matched.match;
          } else {
            target = { heading, depth };
          }
        } else {
          target = { heading, depth };
        }
      } else {
        target = "document";
      }

      const patchRequest: PatchOperation = {
        type: operation,
        target,
        content: content ?? "",
        replaceMode,
      };
      // Heading/block edits preserve the rest of the file byte-for-byte;
      // document targets (and missing offsets) fall back to AST re-serialization.
      let newContent = target === "document"
        ? undefined
        : TextPatcher.apply(source, tree, patchRequest, pipeline);
      if (newContent === undefined) {
        AstPatcher.apply(tree, patchRequest, pipeline);
        newContent = pipeline.stringify(tree);
      }

      const result = await dryRunEditor.execute({
        path: notePath,
        oldContent: source,
        newContent,
        dryRun: dryRun ?? false,
        operationLabel: operation,
      });
      return enrichAndFinalize(result, newContent, targetResolved);
    });
  });

  // ── view tool ───────────────────────────────────────────────────

  const vaultSearcher = new VaultSearcher(deps.fsAdapter);
  const hybridSearcher = new HybridSearcher(deps.vectorStore, deps.embedder);

  server.registerTool("view", {
    title: "View",
    description:
      `Read and search markdown notes. Vault scope: ${vaultScope}.\nActions: search (heading-aware fragment retrieval with TF-IDF + proximity; file-scoped when path is given, otherwise vault- or directory-wide), semantic_search (vector + lexical hybrid for conceptual queries), global_search (cross-vault exact-match grep), outline (file or directory structure tree), read (full file or single section by heading; supports lineNumbers and stat), glob (list paths matching a glob pattern), frontmatter_get (parse YAML frontmatter), bulk_read (read multiple files/headings in one call), backlinks (find all notes linking to a given path). Wiki-links are canonical unescaped [[path]]; use system.normalize_links to fix escaped \\[[ forms.`,
    inputSchema: {
      action: z.enum(["search", "global_search", "semantic_search", "outline", "read", "glob", "frontmatter_get", "bulk_read", "backlinks"]),
      path: z.string().optional().describe("Note path (a .md file). Required for read/outline/frontmatter_get/backlinks; optional for search — omit it to search the whole vault or the given directory."),
      query: z.string().optional(),
      pattern: z.string().optional().describe("For glob: glob pattern over vault-relative paths (supports *, **, ?). Example: 'projects/**/*.md'."),
      maxChunks: z.number().optional(),
      heading: z.string().optional(),
      headingDepth: z.number().optional(),
      lineNumbers: z.boolean().optional().describe("For read: prefix each returned line with its 1-based number ('N: content')."),
      stat: z.boolean().optional().describe("For read: include a file fingerprint (size, mtime, sha256[:12]) in the response."),
      directory: z.string().optional().describe("Scope search/outline to a directory prefix. Used by search/global_search/semantic_search/outline. Example: 'projects/active/'"),
      items: z.array(z.object({
        path: z.string(),
        heading: z.string().optional(),
        headingDepth: z.number().optional(),
      })).optional().describe("For bulk_read: array of files to read, each with optional heading to extract."),
    },
  }, async ({ action, path: notePath, query, maxChunks, heading, headingDepth, lineNumbers, stat, pattern, directory, items }) => {
    return wrapTool(deps.workflow, "view", takePrimingContext(), async () => {
      // Reads a note, rethrowing PathIsDirectoryError with an action-specific
      // hint so callers learn that `path` must point to a file, not a folder.
      // NOTE_NOT_FOUND gains up to two nearest-path suggestions (B3).
      const nearestPathHint = async (requested: string): Promise<string> => {
        try {
          const notes = await deps.fsAdapter.listNotes();
          const matches = FuzzyMatcher.allMatches(requested, notes, 0.5).slice(0, 2);
          if (matches.length > 0) {
            return `did you mean: ${matches.map((m) => JSON.stringify(m.match)).join(", ")}? (use vault list to browse all notes)`;
          }
        } catch {
          // fall through to the generic hint
        }
        return "use vault list to browse available notes";
      };

      const readNoteForView = async (
        filePath: string,
        hint: string,
      ): Promise<string> => {
        try {
          return await deps.fsAdapter.readNote(filePath);
        } catch (err) {
          if (err instanceof PathIsDirectoryError) {
            throw new PathIsDirectoryError(filePath, hint);
          }
          if (err instanceof NoteNotFoundError) {
            throw new NoteNotFoundError(filePath, await nearestPathHint(filePath));
          }
          throw err;
        }
      };

      const actionResult = await (async () => {
        switch (action) {
        case "search": {
          if (!query) throw new InvalidArgumentError("query");
          if (notePath) {
            const source = await readNoteForView(
              notePath,
              "path must point to a note file (.md), not a directory. Omit path to search the whole vault, or use directory to scope it (see global_search/semantic_search).",
            );
            const fragments = retriever.retrieve(source, query, {
              maxChunks: maxChunks ?? 5,
            });
            return fragments.map((f) => ({
              headingPath: f.chunk.headingPath,
              text: f.chunk.text,
              score: Math.round(f.score * 1000) / 1000,
              wordCount: f.chunk.wordCount,
            }));
          }
          const results = await vaultSearcher.search(query, {
            maxResults: maxChunks ?? 20,
            directory,
          });
          return results.map((r) => ({
            filePath: r.filePath,
            headingPath: r.headingPath,
            text: r.text,
            score: Math.round(r.score * 1000) / 1000,
            wordCount: r.wordCount,
          }));
        }
        case "global_search": {
          if (!query) throw new InvalidArgumentError("query");
          const results = await vaultSearcher.search(query, {
            maxResults: maxChunks ?? 20,
            directory,
          });
          return results.map((r) => ({
            filePath: r.filePath,
            headingPath: r.headingPath,
            text: r.text,
            score: Math.round(r.score * 1000) / 1000,
            wordCount: r.wordCount,
          }));
        }
        case "semantic_search": {
          if (!query) throw new InvalidArgumentError("query");
          const results = await hybridSearcher.search(query, {
            k: maxChunks ?? 10,
            directory,
          });
          return results.map((r) => ({
            docPath: r.docPath,
            headingPath: r.headingPath,
            text: r.text,
            score: Math.round(r.score * 1000) / 1000,
            vectorScore: Math.round(r.vectorScore * 1000) / 1000,
            lexicalScore: Math.round(r.lexicalScore * 1000) / 1000,
          }));
        }
        case "outline": {
          if (directory) {
            const files = await deps.fsAdapter.listNotes(directory);
            if (files.length === 0) throw new InvalidArgumentError("directory (no markdown files found)");
            if (files.length > 50) throw new OutlineLimitExceededError("Directory outline limit: max 50 files");
            const results = await Promise.all(files.map(async (filePath) => {
              const source = await deps.fsAdapter.readNote(filePath);
              const tree = pipeline.parse(source);
              return { path: filePath, headings: AstNavigator.findAllHeadings(tree) };
            }));
            return results;
          }
          if (!notePath) throw new InvalidArgumentError("path");
          try {
            const source = await deps.fsAdapter.readNote(notePath);
            const tree = pipeline.parse(source);
            return AstNavigator.findAllHeadings(tree);
          } catch (err) {
            if (!(err instanceof PathIsDirectoryError)) throw err;
            // B2: `path` pointing at a directory is not an error — outline it
            // and record a warning instead of failing.
            const files = await deps.fsAdapter.listNotes(notePath);
            if (files.length === 0) {
              throw new InvalidArgumentError("path (directory has no markdown files)");
            }
            if (files.length > 50) {
              throw new OutlineLimitExceededError("Directory outline limit: max 50 files");
            }
            const results = await Promise.all(files.map(async (filePath) => {
              const source = await deps.fsAdapter.readNote(filePath);
              return { path: filePath, headings: AstNavigator.findAllHeadings(pipeline.parse(source)) };
            }));
            return {
              directory: notePath,
              warnings: [`path ${JSON.stringify(notePath)} is a directory; returning its outline (use the directory parameter to scope explicitly)`],
              files: results,
            };
          }
        }
        case "read": {
          if (!notePath) throw new InvalidArgumentError("path");
          const wantLineNumbers = lineNumbers ?? false;
          const wantStat = stat ?? false;
          const withLineNumbers = (text: string): string =>
            text.split("\n").map((line, index) => `${index + 1}: ${line}`).join("\n");

          if (heading) {
            const repo = new MarkdownFileRepository(deps.fsAdapter, pipeline);
            const useCase = new ReadByHeadingUseCase(repo, pipeline);
            const result = await useCase.execute({
              path: notePath,
              heading,
              headingDepth,
            });
            if (!wantLineNumbers && !wantStat) return result;
            const enriched: Record<string, unknown> = { ...result };
            if (result.found && wantLineNumbers) {
              enriched["content"] = withLineNumbers(result.content);
              enriched["warnings"] = [
                "line numbers are relative to the returned section; use a full-file read (without heading) for line_replace",
              ];
            }
            if (wantStat) {
              enriched["stat"] = await fingerprintNote(deps.fsAdapter, notePath);
            }
            return enriched;
          }

          const content = await readNoteForView(
            notePath,
            "path must point to a note file (.md), not a directory.",
          );
          if (!wantLineNumbers && !wantStat) return content;
          return {
            path: notePath,
            content: wantLineNumbers ? withLineNumbers(content) : content,
            ...(wantStat
              ? { stat: await fingerprintNote(deps.fsAdapter, notePath, content) }
              : {}),
          };
        }
        case "frontmatter_get": {
          if (!notePath) throw new InvalidArgumentError("path");
          const repo = new MarkdownFileRepository(deps.fsAdapter, pipeline);
          const useCase = new GetFrontmatterUseCase(repo);
          const result = await useCase.execute({ path: notePath });
          return result;
        }
        case "bulk_read": {
          if (!items || items.length === 0) {
            return { results: [] };
          }
          const repo = new MarkdownFileRepository(deps.fsAdapter, pipeline);
          const headingReader = new ReadByHeadingUseCase(repo, pipeline);
          const bulkUseCase = new BulkReadUseCase(deps.fsAdapter, headingReader);
          const result = await bulkUseCase.execute({ items });
          return result;
        }
        case "backlinks": {
          if (!notePath) throw new InvalidArgumentError("path");
          if (!deps.backlinkIndex) {
            return { target: notePath, backlinks: [], count: 0 };
          }
          const backlinks = deps.backlinkIndex.getBacklinks(notePath);
          return { target: notePath, backlinks, count: backlinks.length };
        }
        case "glob": {
          if (!pattern) throw new InvalidArgumentError("pattern");
          const files = await deps.fsAdapter.listNotes();
          return matchGlob(pattern, files);
        }
        default:
          throw new InvalidArgumentError("action");
        }
      })();

      return actionResult;
    });
  });

  // ── workflow tool ───────────────────────────────────────────────

  server.registerTool("workflow", {
    title: "Workflow",
    description:
      `Manage optional agent workflow state for this vault (${vaultScope}): status, transition, history, reset. Typical flow: search → open_note → save → done; read vault://overview for usage guidance.`,
    inputSchema: {
      action: z.enum(["status", "transition", "history", "reset"]),
      transition: z.string().optional(),
    },
  }, async ({ action, transition }) => {
    return wrapTool(deps.workflow, "workflow", takePrimingContext(), async () => {
      switch (action) {
        case "status": {
          return {
            currentState: deps.workflow.currentPlace,
            availableTransitions: deps.workflow
              .availableTransitions()
              .map((t) => t.name),
          };
        }
        case "transition": {
          if (!transition) throw new InvalidArgumentError("transition");
          deps.workflow.fire(transition);
          return {
            currentState: deps.workflow.currentPlace,
            firedTransition: transition,
          };
        }
        case "history": {
          return deps.workflow.getHistory();
        }
        case "reset": {
          deps.workflow.hardReset();
          return { currentState: deps.workflow.currentPlace };
        }
        default:
          throw new InvalidArgumentError("action");
      }
    });
  });

  // ── system tool ─────────────────────────────────────────────────

  server.registerTool("system", {
    title: "System",
    description:
      `System administration for this vault (${vaultScope}). Actions: status (indexing/backlinks/workflow health), reindex (async rebuild), overview (folder tree), overview_status (meta/overview.md state), prepare_overview (gather evidence), save_overview (persist host-written overview), selftest (in-vault round-trip check), normalize_links (canonicalize escaped wiki-links, dryRun by default).`,
    inputSchema: {
      action: z.enum(["status", "reindex", "overview", "overview_status", "prepare_overview", "save_overview", "selftest", "normalize_links"]),
      maxDepth: z.number().optional().describe("Maximum folder depth for overview (default 3)."),
      overview: z.string().optional().describe("Overview text to save (required for save_overview action)."),
      scope: z.string().optional().describe("One-line vault routing hint, max 200 chars (required for save_overview action). Should describe what information agents can find here."),
      path: z.string().optional().describe("Note path (required for normalize_links)."),
      dryRun: z.boolean().optional().describe("For normalize_links: preview the diff without writing (default true)."),
    },
  }, async ({ action, maxDepth, overview, scope, path: notePath, dryRun }) => {
    return wrapTool(deps.workflow, "system", takePrimingContext(), async () => {
      switch (action) {
        case "status": {
          const base = {
            indexedDocuments: await deps.vectorStore.size(),
            backlinkIndexSize: deps.backlinkIndex?.indexSize ?? 0,
            workflowState: deps.workflow.currentPlace,
          };
          if (!deps.indexer) return base;
          const health = await deps.indexer.getHealthStatus();
          return {
            ...base,
            indexedDocuments: health.indexedDocuments,
            indexingState: health.indexingState,
            watcherState: health.watcherState,
            queueDepth: health.queueDepth,
            failureCount: health.failureCount,
            lastFailure: health.lastFailure,
          };
        }
        case "reindex": {
          if (deps.indexer) {
            deps.indexer.indexAll()
              .then(async () => {
                if (deps.backlinkIndex) {
                  const allFiles = await deps.fsAdapter.listNotes();
                  const entries = await Promise.all(
                    allFiles.map(async (p) => ({
                      path: p,
                      content: await deps.fsAdapter.readNote(p),
                    })),
                  );
                  deps.backlinkIndex.rebuildIndex(entries);
                }
              })
              .catch((err: unknown) =>
                console.error("Re-indexing failed:", err),
              );
          }
          return { message: "Re-indexing triggered (async)" };
        }
        case "overview": {
          const overviewService = new VaultOverviewService(deps.fsAdapter);
          return overviewService.getOverview(maxDepth);
        }
        case "overview_status": {
          const manager = new OverviewManager({ fsAdapter: deps.fsAdapter });
          return manager.getStatus();
        }
        case "prepare_overview": {
          const manager = new OverviewManager({ fsAdapter: deps.fsAdapter });
          return manager.gatherEvidence();
        }
        case "save_overview": {
          if (typeof overview !== "string" || overview.trim().length === 0) {
            throw new InvalidArgumentError("overview");
          }
          if (typeof scope !== "string" || scope.trim().length === 0) {
            throw new InvalidArgumentError("scope");
          }
          const manager = new OverviewManager({ fsAdapter: deps.fsAdapter });
          await manager.saveOverview(overview.trim(), scope.trim());
          return { saved: true, path: "meta/overview.md" };
        }
        case "selftest": {
          const useCase = new SelftestUseCase(deps.fsAdapter);
          return useCase.execute();
        }
        case "normalize_links": {
          if (!notePath) throw new InvalidArgumentError("path");
          const useCase = new NormalizeLinksUseCase(deps.fsAdapter, new UnifiedDiffService());
          return useCase.execute({ path: notePath, dryRun });
        }
        default:
          throw new InvalidArgumentError("action");
      }
    });
  });

  // ── rebuild-overview prompt ──────────────────────────────────────

  server.registerPrompt(
    "rebuild-overview",
    {
      title: "Rebuild Vault Overview",
      description:
        "Guides the host LLM through the assisted overview flow: gather evidence, generate prose, save, and verify.",
    },
    () => ({
      description:
        "Rebuild the markdown vault overview using the assisted overview flow.",
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              "Rebuild the markdown vault overview using the assisted overview flow.",
              "",
              "Follow these steps exactly:",
              "",
              '1. Call the `system` tool with `{ "action": "prepare_overview" }` to gather structural evidence (file count, directories, tags, recent titles).',
              "",
              "2. Using the returned evidence, generate TWO separate pieces of text:",
              "",
              "   a) **scope** (max 200 chars): A one-line routing hint that tells other agents what information they can find in this MCP server. Focus on WHAT the vault offers — topics, domains, purpose — not structural facts like file counts or folder names. Example: \"Design decisions, architecture notes, and implementation logs for the MCP markdown vault project.\"",
              "",
              "   b) **overview** (3-8 sentences): A fuller semantic description covering the vault's contents, key topic areas, organizational structure, and how agents should use it.",
              "",
              "   Do NOT call an external LLM — generate both texts yourself as the host model.",
              "",
              '3. Call the `system` tool with `{ "action": "save_overview", "overview": "<your overview text>", "scope": "<your scope text>" }` to persist both to `meta/overview.md`.',
              "",
              "4. Read the `vault://overview` resource to verify the saved context, and summarize what changed.",
              "",
              "Important constraints:",
              "- The server does NOT generate prose — you (the host LLM) are responsible for writing both the scope and the overview.",
              "- Do not write to `meta/overview.md` directly; always use `save_overview` so the server manages frontmatter and schema versioning.",
              "- The `scope` is a routing hint: it should describe what agents will find here, NOT repeat evidence data. Keep it under 200 characters.",
              "- The `overview` is the full narrative: aim for 3-8 sentences covering scope, structure, and key topics.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  return server;

  function takePrimingContext(): VaultPrimingContext | undefined {
    if (!firstToolCall) return undefined;
    firstToolCall = false;
    return {
      scope: getVaultScope(),
      hint: vaultOrientationHint,
    };
  }
}

// ── Helpers ────────────────────────────────────────────────────────

interface VaultPrimingContext {
  scope: string;
  hint: string;
}

async function wrapTool<T>(
  workflow: WorkflowStateMachine,
  toolName: ToolName,
  priming: VaultPrimingContext | undefined,
  fn: () => Promise<T>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const result = await fn();
    const enriched = HintsEngine.formatResponse(workflow, toolName, result);
    const response = attachPriming(enriched, priming);
    return {
      content: [{ type: "text", text: JSON.stringify(response) }],
    };
  } catch (err) {
    if (err instanceof DomainError) {
      const errorResponse: Record<string, unknown> = {
        error: err.code,
        message: err.message,
      };
      if (err.hint !== undefined) {
        errorResponse["hint"] = err.hint;
      }
      if (err instanceof AmbiguousHeadingTargetError) {
        errorResponse["candidates"] = err.candidates;
      }
      return {
        content: [{ type: "text", text: JSON.stringify(errorResponse) }],
        isError: true,
      };
    }
    console.error("Unexpected tool error:", err);
    return {
      content: [{ type: "text", text: "Internal error occurred" }],
      isError: true,
    };
  }
}

function attachPriming<T>(response: T, priming: VaultPrimingContext | undefined): T | (T & { _meta: { vault_orientation: VaultPrimingContext } }) {
  if (priming === undefined) return response;

  return Object.assign({}, response, {
    _meta: {
      vault_orientation: priming,
    },
  });
}
