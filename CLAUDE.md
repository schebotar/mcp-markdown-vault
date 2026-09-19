# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Headless, Dockerized TypeScript MCP (Model Context Protocol) server for markdown-based knowledge bases (Obsidian, Logseq, Dendron, Foam, or any folder of `.md` files). Provides semantic search, AST-based note editing, and workflow state tracking via stdio or SSE transport.

## Development Commands

```bash
# Install dependencies
npm install

# Build (compiles to dist/, excludes test files)
npm run build

# Run all tests (879 tests across 63 files)
npm test

# Run a single test file
npx vitest run src/domain/errors/domain-errors.test.ts

# Run tests in watch mode
npm run test:watch

# Lint (type-check without emitting)
npm run lint

# Docker (uses pre-built image from ghcr.io)
docker compose up
```

## Architecture

Clean Architecture with four layers:

- **`src/domain/`** — Domain errors, port interfaces (`IFileSystemAdapter`, `IEmbeddingProvider`, `IVectorStore`, `IMarkdownRepository`, `IDiffService`, `ITemplateEngine`), value objects (`SafePath`)
- **`src/use-cases/`** — Business logic: AST parsing/patching, chunking, scoring, retrieval, hybrid search, read-by-heading, bulk-read, frontmatter management, update-file, dry-run edit, create-from-template, workflow state, hints, fuzzy matching, wikilink resolution, vault indexing
- **`src/infrastructure/`** — Adapters: `LocalFileSystemAdapter` (fs/promises), `OllamaEmbeddingProvider` (REST), `TransformersEmbeddingProvider` (local `@huggingface/transformers`), `InMemoryVectorStore` (cosine similarity), `MarkdownFileRepository` (AST + frontmatter from file), `UnifiedDiffService` (unified diff via `diff` package), `RegexTemplateEngine` (`{{key}}` placeholder replacement)
- **`src/presentation/`** — 5 MCP tool bindings (`createMcpServer()`), transport layer (`transport.ts`: stdio/SSE selection, Express SSE app)

Entry point: `src/index.ts` — composition root, reads env vars, wires dependencies, selects transport.

### Key Subsystems

- **AST Parser** (`markdown-pipeline.ts`, `ast-navigation.ts`, `ast-patcher.ts`): unified pipeline (remark-parse + remark-gfm + remark-frontmatter) for surgical markdown patching (append/prepend/replace/delete by heading or block ID); supports `replaceMode: body|section`
- **Text Patcher** (`text-patcher.ts`): byte-preserving default path — only the targeted region of the ORIGINAL text is spliced, and the inserted `content` is written verbatim (never through remark-stringify). Heading/block targets use `apply()`, whole-document targets use `applyDocument()`; `edit normalize: true` opts back into full remark re-serialization
- **Heading Targeting** (`heading-target.ts`): resolves `heading` + optional `headingDepth`, tolerating a wrong depth — a unique match at another depth applies with a warning and `resolvedDepth`, several matches list every candidate with its depth, and a total miss throws `HEADING_NOT_FOUND` with `suggestions`
- **Vault Ignore** (`vault-ignore.ts`): single source of truth for which paths are notes — dot-prefixed segments (`.obsidian`, `.trash`, `.stversions`, …), `node_modules`, plus `VAULT_IGNORE` (CSV) and `.vaultignore` globs. Applied once in `LocalFileSystemAdapter.listNotes`, so listings, search, the vector index, the overview and `vault stats` all agree; `includeHidden: true` is the escape hatch
- **Directory Outline** (`directory-outline.ts`): builds the subdirectory tree with direct/recursive file counts used by `view.outline` (summary mode) and `vault list mode=tree`
- **Portable Paths** (`portable-path.ts`): cross-platform (Windows-safe) name rules — reserved characters `<>:"|?*`, control characters, trailing dot/space, device names `CON`/`PRN`/`AUX`/`NUL`/`COM1-9`/`LPT1-9`, >255 chars, plus an optional ASCII-only mode. Enforced by `LocalFileSystemAdapter` on **creation only** (the note file plus directory segments that do not exist yet), so reading/editing/searching an already non-portable note keeps working; `NonPortablePathError` (`NON_PORTABLE_PATH`) carries every violation. Policy comes from `VAULT_PATH_POLICY` (`error` by default, `warn`, `off`, with a `:strict-ascii` suffix). `audit-names.ts` + `vault action="audit_names"` list existing offenders read-only
- **Fragment Retrieval** (`chunker.ts`, `scoring.ts`, `fragment-retrieval.ts`): heading-aware markdown chunking with TF-IDF + word proximity scoring
- **Semantic Search** (`hybrid-search.ts`, `vault-indexer.ts`): hybrid search combining vector similarity with lexical TF-IDF; background auto-vectorization via chokidar file watcher with debounce; supports optional directory scoping via post-filter
- **Embedding Strategy** (`index.ts`): auto-selects provider — local `TransformersEmbeddingProvider` (zero-setup) or `OllamaEmbeddingProvider` when `OLLAMA_URL` is set and reachable
- **Workflow** (`workflow-state.ts`, `hints.ts`): Petri net state machine (IDLE → EXPLORING → EDITING → REVIEWING); contextual hints appended to all tool responses
- **Fuzzy Matching** (`fuzzy-match.ts`): Levenshtein-based typo resilience for edit operations
- **Transport** (`transport.ts`): dual transport — stdio (default, single client) or SSE over HTTP (multi-client); each SSE connection gets its own McpServer + WorkflowStateMachine while sharing fs/vector/embedder deps
- **Vault Search** (`vault-search.ts`): cross-vault lexical keyword search using FragmentRetriever — no embeddings required; supports optional directory scoping
- **Freeform Editor** (`freeform-editor.ts`): line-range replacement and literal string find/replace as fallback for non-AST content
- **Read by Heading** (`read-by-heading.ts`): AST-based section extraction — reads content under a specific heading (up to next same-or-higher-level heading) to save context window space; returns suggestions/guidance if heading not found
- **Frontmatter Management** (`frontmatter.ts`, `frontmatter-surgery.ts`): safe read/update of YAML frontmatter — `extractFrontmatterRaw`/`replaceFrontmatterBlock` keep the markdown body byte-for-byte, and `mergeFrontmatterPreservingStyle` rewrites only the touched keys, preserving order, quoting, trailing comments and appending new keys at the end; `InvalidFrontmatterPayloadError` for malformed JSON input
- **Update File** (`update-file.ts`): full content replacement with upsert semantics (create or overwrite)
- **Dry-Run Edit** (`dry-run-edit.ts`): coordinates edit preview vs commit — when `dryRun=true`, returns unified diff via `IDiffService` without writing; when false, writes to disk
- **Bulk Read** (`bulk-read.ts`): reads multiple files/heading-scoped sections concurrently in a single call with per-item fault tolerance — reuses `IFileSystemAdapter` and `ReadByHeadingUseCase`
- **Templating** (`create-from-template.ts`, `regex-template-engine.ts`): creates new notes from template files with `{{variable}}` placeholder injection via `ITemplateEngine`; refuses to overwrite existing destination files (`NoteAlreadyExistsError`)
- **5 MCP Tools**: vault (CRUD + update + delete `pruneEmptyDirs` + list with `limit`/`mode=tree`/`includeHidden` + create_from_template + `audit_names` for existing non-portable names), edit (byte-preserving AST patching + freeform line_replace/string_replace + `frontmatter` object or legacy JSON `frontmatter_set` + `normalize` opt-in + dryRun diff preview + returnContent + batch), view (fragment retrieval + global_search + semantic_search + outline summary/files + read by heading + glob with exclude/sort/limit + frontmatter_get + bulk_read + backlinks); `view.outline` and `vault list` support `directory` scoping and always report `totalFiles`/`truncated`

### Security

All file operations route through `SafePath` value object — prevents path traversal (`../`, encoded variants, backslash, null bytes). `LocalFileSystemAdapter` uses atomic writes (temp file + rename).

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `VAULT_PATH` | `/vault` | Markdown vault directory |
| `VAULT_CONTEXT_MODE` | `assisted` | Vault orientation mode: `assisted` (host LLM/agent calls `prepare_overview`, writes prose, then calls `save_overview`) or `manual` (user authors `meta/overview.md`). `auto` is a deprecated alias for `assisted`. |
| `VAULT_CONTEXT` | *(deprecated)* | Deprecated — ignored. Use `VAULT_CONTEXT_MODE` instead. |
| `VAULT_IGNORE` | *(unset)* | CSV of extra glob patterns excluded from note listings, search and the vector index (e.g. `Archive/**,drafts/**`). Dot-prefixed path segments and `node_modules` are always excluded; `.vaultignore` in the vault root is merged in. `vault list` / `view.glob` accept `includeHidden: true`. |
| `VAULT_PATH_POLICY` | `error` | Windows-safe name guard for **newly created** notes/directories: `error` rejects Windows-illegal names (reserved characters, control chars, trailing dot/space, `CON`/`PRN`/`AUX`/`NUL`/`COM1-9`/`LPT1-9`, >255 chars), `warn` logs only, `off` disables. `:strict-ascii` suffix also rejects non-ASCII names. Existing notes, reads, edits and overwrites are never blocked. |
| `MCP_TRANSPORT_TYPE` | `stdio` | Transport: `stdio` (single client) or `sse` (multi-client HTTP) |
| `PORT` | `3000` | HTTP port (SSE mode only) |
| `OLLAMA_URL` | *(unset)* | Set to enable Ollama embeddings; if unset, local embeddings are used |
| `OLLAMA_MODEL` | `nomic-embed-text` | Ollama embedding model name |
| `OLLAMA_DIMENSIONS` | `768` | Ollama embedding vector dimensions |
| `VECTOR_STORE_URL` | *(unset)* | Set to use Qdrant (e.g. `http://localhost:6333`). If unset, local persisted flat store is used. |
| `VECTOR_STORE_RESET` | `false` | Set to `true` to auto-delete a mismatched vector index on startup and rebuild from scratch. |
| `MCP_AUTH_TOKEN` | *(unset)* | Bearer token for SSE transport auth. If set, all SSE endpoints require `Authorization: Bearer <token>`. |

## Conventions

### Layer Dependencies (strictly enforced)

- **Domain** → no imports from other layers
- **Use Cases** → may import domain only
- **Infrastructure** → may import domain only
- **Presentation** → may import all layers (composition root)

### TypeScript

- ESM (`"type": "module"`) — use `node:` prefix for Node built-ins (e.g. `node:fs/promises`, `node:path`)
- Strict mode with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals`, `noUnusedParameters`
- Explicit types at module boundaries; infer internally

### Error Handling

- Throw domain-specific errors (subclasses of `DomainError` in `src/domain/errors/index.ts`) with machine-readable `code` fields
- Catch and wrap infrastructure errors into domain errors at the adapter boundary

### Testing

- Co-located test files: `module.ts` → `module.test.ts` in the same directory
- Use real temp directories for file system tests — no mocks
- Use `InMemoryTransport` from `@modelcontextprotocol/sdk` for MCP integration tests
- All file paths in tests must go through `SafePath`

### CI/CD & Release

- **Semantic Release** via `.releaserc.json` — version bumps from [Conventional Commits](https://www.conventionalcommits.org/) (`feat:` = minor, `fix:` = patch, `feat!:` = major)
- **NPM:** published as `@wirux/mcp-markdown-vault` (scoped, public)
- **Docker:** multi-arch images (`linux/amd64` + `linux/arm64`) pushed to `ghcr.io/wirux/mcp-markdown-vault`
- **PR Check** (`.github/workflows/pr-check.yml`): lint → build → test → Docker dry run on every PR to `main`
- **Release** (`.github/workflows/release.yml`): lint → test → semantic-release → Docker build & push on push to `main`
- `docker-compose.yml` uses the pre-built `ghcr.io/wirux/mcp-markdown-vault:latest` image (not local build) 
