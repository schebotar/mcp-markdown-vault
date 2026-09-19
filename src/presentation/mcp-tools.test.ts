import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createMcpServer, type McpDependencies } from "./mcp-tools.js";
import { LocalFileSystemAdapter } from "../infrastructure/local-fs-adapter.js";
import { UnifiedDiffService } from "../infrastructure/diff-service.js";
import { InMemoryVectorStore } from "../infrastructure/vector-store/in-memory-vector-store.js";
import { WorkflowStateMachine } from "../use-cases/workflow-state.js";
import { VaultIndexer } from "../use-cases/vault-indexer.js";
import type { IEmbeddingProvider, IFileWatcher, WatchEventType } from "../domain/interfaces/index.js";
import { MarkdownPipeline } from "../use-cases/markdown-pipeline.js";
import { BacklinkIndexService } from "../use-cases/backlink-index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

type TextResource = { uri: string; text: string; mimeType?: string };

function getTextResourceContent(resource: unknown): TextResource {
  if (
    typeof resource === "object"
    && resource !== null
    && "text" in resource
    && typeof (resource as { text: unknown }).text === "string"
  ) {
    return resource as TextResource;
  }
  throw new Error("Expected text resource content");
}

// ── Fake embedding provider ──────────────────────────────────────

class FakeEmbedder implements IEmbeddingProvider {
  readonly dimensions = 3;
  readonly modelName = "fake";
  async embed(text: string): Promise<number[]> {
    const h = [...text].reduce((s, c) => ((s << 5) - s + c.charCodeAt(0)) | 0, 0);
    return [Math.sin(h), Math.cos(h), Math.sin(h * 2)];
  }
  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

class StubFileWatcher implements IFileWatcher {
  watch(): void {}
  on(_event: WatchEventType, _handler: (_path: string) => void): void {}
  async close(): Promise<void> {}
}

// ── Test setup ────────────────────────────────────────────────────

let tmpDir: string;
let deps: McpDependencies;
let client: Client;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-test-"));

  // Seed some notes
  await fs.mkdir(path.join(tmpDir, "daily"), { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, "hello.md"),
    "---\ntitle: Hello\n---\n\n# Hello World\n\nWelcome to the vault.\n\n## Getting Started\n\nStart here.\n",
  );
  await fs.writeFile(
    path.join(tmpDir, "daily/2024-01-01.md"),
    "# Daily Note\n\nToday I learned about MCP. See [[hello]].\n",
  );

  const fsAdapter = await LocalFileSystemAdapter.create(tmpDir);
  const vectorStore = new InMemoryVectorStore();
  const embedder = new FakeEmbedder();
  const workflow = new WorkflowStateMachine();

  // Backlink index
  const backlinkPipeline = new MarkdownPipeline();
  const backlinkIndex = new BacklinkIndexService(backlinkPipeline);
  backlinkIndex.rebuildIndex([
    { path: "hello.md", content: "---\ntitle: Hello\n---\n\n# Hello World\n\nWelcome to the vault.\n\n## Getting Started\n\nStart here.\n" },
    { path: "daily/2024-01-01.md", content: "# Daily Note\n\nToday I learned about MCP. See [[hello]].\n" },
  ]);

  deps = {
    fsAdapter,
    vectorStore,
    embedder,
    workflow,
    vaultRoot: tmpDir,
    backlinkIndex,
    instructions: "test instructions",
    getVaultScope: () => "test vault",
  };

  const server = createMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  client = new Client({ name: "test-client", version: "1.0.0" });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  cleanup = async () => {
    await client.close();
    await server.close();
  };
});

afterEach(async () => {
  await cleanup();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── Tool listing ──────────────────────────────────────────────────

describe("MCP Server — tool listing", () => {
  it("exposes exactly 5 tools", async () => {
    const result = await client.listTools();
    expect(result.tools.length).toBe(5);
  });

  it("exposes vault, edit, view, workflow, system tools", async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(["edit", "system", "vault", "view", "workflow"]);
  });

  it("all tools have descriptions", async () => {
    const result = await client.listTools();
    for (const tool of result.tools) {
      expect(tool.description).toBeTruthy();
    }
  });

  it("all tool descriptions include vault scope text", async () => {
    const result = await client.listTools();
    for (const tool of result.tools) {
      expect(tool.description).toContain("test vault");
    }
  });
});

describe("MCP Server — resources and priming", () => {
  it("listResources returns 2 resources with expected URIs", async () => {
    const result = await client.listResources();
    const uris = result.resources.map((resource) => resource.uri).sort();
    expect(uris).toEqual(["vault://overview", "vault://stats"]);
  });

  it("readResource overview returns markdown starting with vault heading", async () => {
    await fs.mkdir(path.join(tmpDir, "meta"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "meta/overview.md"),
      "---\ntitle: Overview\n---\n\n# Overview\n\nHelpful overview content.\n",
    );

    const result = await client.readResource({ uri: "vault://overview" });
    const content = result.contents[0];
    expect(content).toBeDefined();
    expect(getTextResourceContent(content).text.startsWith("# Vault Overview")).toBe(true);
  });

  it("readResource overview includes agent orientation guidance", async () => {
    const result = await client.readResource({ uri: "vault://overview" });
    const text = getTextResourceContent(result.contents[0]).text;

    expect(text).toContain("## Agent Orientation");
    expect(text).toContain("### Search Strategy");
    expect(text).toContain("view.semantic_search");
    expect(text).toContain("dryRun=true");
    expect(text).toContain("system.prepare_overview");
  });

  it("readResource overview includes contract.md content when present", async () => {
    await fs.mkdir(path.join(tmpDir, "meta"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "meta/contract.md"),
      "# Contract\n\nVault contract content.\n",
    );

    const result = await client.readResource({ uri: "vault://overview" });
    const content = result.contents[0];
    expect(content).toBeDefined();
    const text = getTextResourceContent(content).text;
    expect(text).toContain("Vault contract content.");
  });

  it("readResource stats returns valid JSON with expected fields", async () => {
    const result = await client.readResource({ uri: "vault://stats" });
    const content = result.contents[0];
    expect(content).toBeDefined();
    const parsed = JSON.parse(getTextResourceContent(content).text) as {
      fileCount: number;
      indexStatus: string;
      embeddingProvider: string;
    };

    expect(parsed.fileCount).toBe(2);
    expect(parsed.indexStatus).toBe("not started");
    expect(parsed.embeddingProvider).toBe("fake");
  });

  it("first tool call returns vault orientation priming metadata", async () => {
    const result = await client.callTool({
      name: "vault",
      arguments: { action: "list" },
    });
    const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text);

    expect(parsed.result.notes).toEqual(["daily/2024-01-01.md", "hello.md"]);
    expect(parsed.result.totalFiles).toBe(2);
    expect(parsed.result.truncated).toBe(false);
    expect(parsed._meta.vault_orientation).toEqual({
      scope: "test vault",
      hint: "Read vault://overview resource for full vault context, search strategy, workflow guidance, and conventions.",
    });
  });

  it("second tool call does not return vault orientation priming metadata", async () => {
    await client.callTool({ name: "vault", arguments: { action: "list" } });

    const secondResult = await client.callTool({
      name: "view",
      arguments: { action: "backlinks", path: "hello.md" },
    });
    const parsed = JSON.parse((secondResult.content as Array<{ type: string; text: string }>)[0]!.text);

    expect(parsed._meta).toBeUndefined();
  });

  it("server initialization result includes non-empty instructions", () => {
    expect(client.getInstructions()).toBe("test instructions");
  });
});

// ── vault tool ────────────────────────────────────────────────────

describe("vault tool", () => {
  it("lists notes", async () => {
    const result = await client.callTool({
      name: "vault",
      arguments: { action: "list" },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const text = content[0]!.text;
    const parsed = JSON.parse(text);
    expect(parsed.result.notes).toContain("hello.md");
    expect(parsed.result.notes).toContain("daily/2024-01-01.md");
    expect(parsed.result.totalFiles).toBe(2);
    expect(parsed.result.truncated).toBe(false);
  });

  it("reads a note", async () => {
    const result = await client.callTool({
      name: "vault",
      arguments: { action: "read", path: "hello.md" },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text);
    expect(parsed.result).toContain("Hello World");
  });

  it("creates a new note", async () => {
    const result = await client.callTool({
      name: "vault",
      arguments: {
        action: "create",
        path: "new-note.md",
        content: "# New Note\n\nFresh content.\n",
      },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text);
    expect(parsed.result).toContain("created");

    // Verify file exists
    const fileContent = await fs.readFile(
      path.join(tmpDir, "new-note.md"),
      "utf-8",
    );
    expect(fileContent).toContain("Fresh content.");
  });

  it("returns error for invalid action", async () => {
    const result = await client.callTool({
      name: "vault",
      arguments: { action: "invalid" },
    });
    expect(result.isError).toBe(true);
  });

  it("includes hints in response", async () => {
    const result = await client.callTool({
      name: "vault",
      arguments: { action: "list" },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text);
    expect(parsed.hints).toBeDefined();
    expect(parsed.hints.currentState).toBeDefined();
    expect(parsed.hints.nextActions.length).toBeGreaterThan(0);
  });

  it("refuses to create a note whose name Windows cannot store", async () => {
    const result = await client.callTool({
      name: "vault",
      arguments: {
        action: "create",
        path: "Встречи/12:30.md",
        content: "# Meeting\n",
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text);
    expect(parsed.error).toBe("NON_PORTABLE_PATH");
    expect(parsed.violations[0].code).toBe("RESERVED_CHARACTER");
    expect(parsed.violations[0].segment).toBe("12:30.md");
    expect(parsed.hint).toContain("VAULT_PATH_POLICY=off");

    // Nothing was created on disk.
    await expect(fs.access(path.join(tmpDir, "Встречи"))).rejects.toThrow();
  });

  it("creates a portable note with Cyrillic and spaces in the name", async () => {
    const result = await client.callTool({
      name: "vault",
      arguments: {
        action: "create",
        path: "Встречи/2026-09-15 Планёрка.md",
        content: "# Планёрка\n",
      },
    });

    expect(result.isError).toBeUndefined();
    const fileContent = await fs.readFile(
      path.join(tmpDir, "Встречи/2026-09-15 Планёрка.md"),
      "utf-8",
    );
    expect(fileContent).toContain("Планёрка");
  });

  it("reports existing non-portable names without touching them", async () => {
    await fs.writeFile(path.join(tmpDir, "legacy 12:30.md"), "# Old\n");

    const result = await client.callTool({
      name: "vault",
      arguments: { action: "audit_names" },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    const audit = JSON.parse(content[0]!.text).result;
    expect(audit.nonPortableCount).toBe(1);
    expect(audit.notes[0].path).toBe("legacy 12:30.md");
    expect(audit.notes[0].violations[0].code).toBe("RESERVED_CHARACTER");

    // The file is still there and still readable.
    const read = await client.callTool({
      name: "vault",
      arguments: { action: "read", path: "legacy 12:30.md" },
    });
    expect(read.isError).toBeUndefined();
  });

  it("audit_names reports nothing for a clean vault", async () => {
    const result = await client.callTool({
      name: "vault",
      arguments: { action: "audit_names" },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    const audit = JSON.parse(content[0]!.text).result;
    expect(audit.nonPortableCount).toBe(0);
    expect(audit.scannedFiles).toBeGreaterThan(0);
  });
});

// ── view tool ─────────────────────────────────────────────────────

describe("view tool", () => {
  beforeEach(async () => {
    await client.callTool({
      name: "view",
      arguments: { action: "backlinks", path: "hello.md" },
    });
  });

  it("retrieves fragments for a query", async () => {
    const result = await client.callTool({
      name: "view",
      arguments: { action: "search", query: "Getting Started", path: "hello.md" },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text);
    expect(parsed.result.length).toBeGreaterThan(0);
  });

  it("shows note headings outline", async () => {
    const result = await client.callTool({
      name: "view",
      arguments: { action: "outline", path: "hello.md" },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text);
    expect(parsed.result.some((h: { title: string }) => h.title === "Hello World")).toBe(true);
    expect(parsed.result.some((h: { title: string }) => h.title === "Getting Started")).toBe(true);
  });

  it("performs global_search across vault", async () => {
    const result = await client.callTool({
      name: "view",
      arguments: { action: "global_search", query: "learned about MCP" },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text);
    expect(parsed.result.length).toBeGreaterThan(0);
    expect(parsed.result[0].filePath).toBeDefined();
    expect(parsed.result[0].score).toBeDefined();
  });

  it("returns empty for global_search with no matches", async () => {
    const result = await client.callTool({
      name: "view",
      arguments: { action: "global_search", query: "xyznonexistent" },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text);
    expect(parsed.result).toEqual([]);
  });

  it("performs semantic_search (returns results or empty based on index)", async () => {
    const result = await client.callTool({
      name: "view",
      arguments: { action: "semantic_search", query: "hello world" },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text);
    // With an empty vector store, semantic_search returns empty
    expect(Array.isArray(parsed.result)).toBe(true);
  });

  it("returns error for global_search without query", async () => {
    const result = await client.callTool({
      name: "view",
      arguments: { action: "global_search" },
    });
    expect(result.isError).toBe(true);
  });

  it("returns backlinks for a target note", async () => {
    const result = await client.callTool({
      name: "view",
      arguments: { action: "backlinks", path: "hello.md" },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text);

    expect(parsed.result.target).toBe("hello.md");
    expect(parsed.result.count).toBe(1);
    expect(parsed.result.backlinks).toHaveLength(1);
    expect(parsed.result.backlinks[0].sourcePath).toBe("daily/2024-01-01.md");
    expect(parsed.result.backlinks[0].linkType).toBe("wikilink");
  });
});

// ── edit tool ─────────────────────────────────────────────────────

describe("edit tool", () => {
  it("appends content under a heading", async () => {
    const result = await client.callTool({
      name: "edit",
      arguments: {
        path: "hello.md",
        operation: "append",
        heading: "Getting Started",
        headingDepth: 2,
        content: "Additional info here.",
      },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text);
    expect(parsed.result.message).toContain("patched");

    const fileContent = await fs.readFile(
      path.join(tmpDir, "hello.md"),
      "utf-8",
    );
    expect(fileContent).toContain("Additional info here.");
    expect(fileContent).toContain("## Getting Started");
  });

  it("replaces lines with line_replace", async () => {
    const result = await client.callTool({
      name: "edit",
      arguments: {
        path: "daily/2024-01-01.md",
        operation: "line_replace",
        startLine: 3,
        endLine: 3,
        content: "Today I learned about freeform editing.",
      },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text);
    expect(parsed.result.message).toContain("line_replace");

    const fileContent = await fs.readFile(
      path.join(tmpDir, "daily/2024-01-01.md"),
      "utf-8",
    );
    expect(fileContent).toContain("Today I learned about freeform editing.");
    expect(fileContent).not.toContain("Today I learned about MCP.");
  });

  it("replaces string with string_replace", async () => {
    const result = await client.callTool({
      name: "edit",
      arguments: {
        path: "hello.md",
        operation: "string_replace",
        searchText: "Welcome to the vault.",
        content: "Welcome to the new vault.",
      },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text);
    expect(parsed.result.message).toContain("string_replace");

    const fileContent = await fs.readFile(
      path.join(tmpDir, "hello.md"),
      "utf-8",
    );
    expect(fileContent).toContain("Welcome to the new vault.");
  });

  it("returns error for line_replace without startLine/endLine", async () => {
    const result = await client.callTool({
      name: "edit",
      arguments: {
        path: "hello.md",
        operation: "line_replace",
        content: "x",
      },
    });
    expect(result.isError).toBe(true);
  });

  it("returns error for string_replace without searchText", async () => {
    const result = await client.callTool({
      name: "edit",
      arguments: {
        path: "hello.md",
        operation: "string_replace",
        content: "x",
      },
    });
    expect(result.isError).toBe(true);
  });

  it("executes batch edit with multiple operations", async () => {
    const result = await client.callTool({
      name: "edit",
      arguments: {
        operations: [
          { path: "hello.md", operation: "append", content: "Batch line 1." },
          { path: "daily/2024-01-01.md", operation: "append", content: "Batch line 2." },
        ],
      },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text);

    expect(parsed.result.totalRequested).toBe(2);
    expect(parsed.result.totalSucceeded).toBe(2);
    expect(parsed.result.totalFailed).toBe(0);

    const file1 = await fs.readFile(path.join(tmpDir, "hello.md"), "utf-8");
    expect(file1).toContain("Batch line 1.");
    const file2 = await fs.readFile(path.join(tmpDir, "daily/2024-01-01.md"), "utf-8");
    expect(file2).toContain("Batch line 2.");
  });

  it("returns a diff and does not write for single frontmatter_set dryRun", async () => {
    const original = await fs.readFile(path.join(tmpDir, "hello.md"), "utf-8");

    const result = await client.callTool({
      name: "edit",
      arguments: {
        path: "hello.md",
        operation: "frontmatter_set",
        content: '{"status":"draft"}',
        dryRun: true,
      },
    });

    const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text);
    expect(parsed.result.message).toContain("dry-run");
    expect(parsed.result.diff).toContain("status: draft");

    const fileContent = await fs.readFile(path.join(tmpDir, "hello.md"), "utf-8");
    expect(fileContent).toBe(original);
    expect(fileContent).not.toContain("status: draft");
  });

  it("writes frontmatter for single frontmatter_set when dryRun is false", async () => {
    const result = await client.callTool({
      name: "edit",
      arguments: {
        path: "hello.md",
        operation: "frontmatter_set",
        content: '{"status":"published"}',
      },
    });

    const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text);
    expect(parsed.result.message).toContain("patched");

    const fileContent = await fs.readFile(path.join(tmpDir, "hello.md"), "utf-8");
    expect(fileContent).toContain("status: published");
  });

  it("returns a diff and does not write for batch frontmatter_set dryRun", async () => {
    const original = await fs.readFile(path.join(tmpDir, "hello.md"), "utf-8");

    const result = await client.callTool({
      name: "edit",
      arguments: {
        operations: [
          { path: "hello.md", operation: "frontmatter_set", content: '{"category":"guide"}' },
        ],
        dryRun: true,
      },
    });

    const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text);
    expect(parsed.result.totalSucceeded).toBe(1);
    expect(parsed.result.results[0].diff).toContain("category: guide");

    const fileContent = await fs.readFile(path.join(tmpDir, "hello.md"), "utf-8");
    expect(fileContent).toBe(original);
    expect(fileContent).not.toContain("category: guide");
  });
});

// ── workflow tool ─────────────────────────────────────────────────

describe("workflow tool", () => {
  it("returns current workflow state", async () => {
    const result = await client.callTool({
      name: "workflow",
      arguments: { action: "status" },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text);
    expect(parsed.result.currentState).toBe("idle");
  });

  it("fires a transition", async () => {
    const result = await client.callTool({
      name: "workflow",
      arguments: { action: "transition", transition: "search" },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text);
    expect(parsed.result.currentState).toBe("exploring");
  });

  it("returns error for invalid transition", async () => {
    const result = await client.callTool({
      name: "workflow",
      arguments: { action: "transition", transition: "save" },
    });
    expect(result.isError).toBe(true);
  });
});

// ── backlink live updates ─────────────────────────────────────────

describe("backlink index — live updates via MCP operations", () => {
  it("vault.create updates backlink index", async () => {
    await client.callTool({
      name: "vault",
      arguments: {
        action: "create",
        path: "linker.md",
        content: "# Linker\n\nSee [[hello]].\n",
      },
    });

    const result = await client.callTool({
      name: "view",
      arguments: { action: "backlinks", path: "hello.md" },
    });
    const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text);

    // daily/2024-01-01.md (from beforeEach) + linker.md (newly created)
    expect(parsed.result.count).toBe(2);
    const sources = parsed.result.backlinks.map((b: { sourcePath: string }) => b.sourcePath).sort();
    expect(sources).toContain("linker.md");
  });

  it("vault.delete removes backlink entries from that source", async () => {
    // First verify that daily/2024-01-01.md is a backlink source
    const before = await client.callTool({
      name: "view",
      arguments: { action: "backlinks", path: "hello.md" },
    });
    const beforeParsed = JSON.parse((before.content as Array<{ type: string; text: string }>)[0]!.text);
    expect(beforeParsed.result.count).toBe(1);

    // Delete the file that is a link source
    await client.callTool({
      name: "vault",
      arguments: { action: "delete", path: "daily/2024-01-01.md" },
    });

    const after = await client.callTool({
      name: "view",
      arguments: { action: "backlinks", path: "hello.md" },
    });
    const afterParsed = JSON.parse((after.content as Array<{ type: string; text: string }>)[0]!.text);
    expect(afterParsed.result.count).toBe(0);
  });

  it("edit.string_replace updates backlink index", async () => {
    // Create the link target
    await client.callTool({
      name: "vault",
      arguments: {
        action: "create",
        path: "target.md",
        content: "# Target\n",
      },
    });

    // Replace text adding a link (string_replace bypasses AST, so wikilinks are preserved)
    const editResult = await client.callTool({
      name: "edit",
      arguments: {
        path: "hello.md",
        operation: "string_replace",
        searchText: "Welcome to the vault.",
        content: "Welcome to the vault. See [[target]].",
      },
    });
    expect(editResult.isError).toBeFalsy();

    const result = await client.callTool({
      name: "view",
      arguments: { action: "backlinks", path: "target.md" },
    });
    const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text);
    expect(parsed.result.count).toBe(1);
    expect(parsed.result.backlinks[0].sourcePath).toBe("hello.md");
  });

  it("full sequence: create → backlinks → delete → backlinks", async () => {
    // 1. Create target
    await client.callTool({
      name: "vault",
      arguments: { action: "create", path: "target.md", content: "# Target\n" },
    });

    // 2. Create a linking file
    await client.callTool({
      name: "vault",
      arguments: { action: "create", path: "linker.md", content: "See [[target]]\n" },
    });

    // 3. Check backlinks — should be 1
    const mid = await client.callTool({
      name: "view",
      arguments: { action: "backlinks", path: "target.md" },
    });
    const midParsed = JSON.parse((mid.content as Array<{ type: string; text: string }>)[0]!.text);
    expect(midParsed.result.count).toBe(1);

    // 4. Delete the linking file
    await client.callTool({
      name: "vault",
      arguments: { action: "delete", path: "linker.md" },
    });

    // 5. Check backlinks — should be 0
    const end = await client.callTool({
      name: "view",
      arguments: { action: "backlinks", path: "target.md" },
    });
    const endParsed = JSON.parse((end.content as Array<{ type: string; text: string }>)[0]!.text);
    expect(endParsed.result.count).toBe(0);
  });
});

// ── rebuild-overview prompt ───────────────────────────────────────

describe("MCP Server — rebuild-overview prompt", () => {
  it("prompt is discoverable via listPrompts", async () => {
    const result = await client.listPrompts();
    const names = result.prompts.map((p) => p.name);
    expect(names).toContain("rebuild-overview");
    expect(names).not.toContain("vault-rebuild-overview");
  });

  it("prompt has a description in the listing", async () => {
    const result = await client.listPrompts();
    const prompt = result.prompts.find((p) => p.name === "rebuild-overview");
    expect(prompt?.description).toBeTruthy();
  });

  it("getPrompt returns instructions mentioning prepare_overview", async () => {
    const result = await client.getPrompt({ name: "rebuild-overview" });
    const text = result.messages[0]!.content as { type: string; text: string };
    expect(text.text).toContain("prepare_overview");
  });

  it("getPrompt returns instructions mentioning save_overview", async () => {
    const result = await client.getPrompt({ name: "rebuild-overview" });
    const text = result.messages[0]!.content as { type: string; text: string };
    expect(text.text).toContain("save_overview");
  });

  it("getPrompt returns instructions mentioning vault://overview", async () => {
    const result = await client.getPrompt({ name: "rebuild-overview" });
    const text = result.messages[0]!.content as { type: string; text: string };
    expect(text.text).toContain("vault://overview");
  });

  it("getPrompt instructions make clear the server does not generate prose", async () => {
    const result = await client.getPrompt({ name: "rebuild-overview" });
    const text = result.messages[0]!.content as { type: string; text: string };
    expect(text.text).toContain("server does NOT generate prose");
  });

  it("prompt returns a single user-role message", async () => {
    const result = await client.getPrompt({ name: "rebuild-overview" });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.role).toBe("user");
  });
});

// ── system tool ───────────────────────────────────────────────────

describe("system tool", () => {
  it("returns system status with backlinkIndexSize", async () => {
    const result = await client.callTool({
      name: "system",
      arguments: { action: "status" },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text);
    expect(typeof parsed.result.indexedDocuments).toBe("number");
    expect(typeof parsed.result.backlinkIndexSize).toBe("number");
    expect(parsed.result.backlinkIndexSize).toBeGreaterThan(0);
    expect(parsed.result.vaultRoot).toBeUndefined();
  });

  it("returns vault overview with folder structure", async () => {
    const result = await client.callTool({
      name: "system",
      arguments: { action: "overview" },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text);

    expect(parsed.result.totalFiles).toBe(2);
    expect(Array.isArray(parsed.result.folders)).toBe(true);

    // hello.md is in the root directory, so "." is the root
    const root = parsed.result.folders.find((f: { path: string }) => f.path === ".");
    expect(root).toBeDefined();
    expect(root.fileCount).toBe(1);

    // daily/ is a child of the root
    const daily = root.children.find((f: { path: string }) => f.path === "daily");
    expect(daily).toBeDefined();
    expect(daily.fileCount).toBe(1);
  });
});

describe("system tool — indexer health fields", () => {
  let indexerTmpDir: string;
  let indexerClient: Client;
  let indexerCleanup: () => Promise<void>;

  beforeEach(async () => {
    indexerTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-indexer-test-"));
    await fs.writeFile(
      path.join(indexerTmpDir, "note.md"),
      "# Note\n\nContent.\n",
    );

    const fsAdapter = await LocalFileSystemAdapter.create(indexerTmpDir);
    const vectorStore = new InMemoryVectorStore();
    const embedder = new FakeEmbedder();
    const workflow = new WorkflowStateMachine();
    const indexer = new VaultIndexer(
      indexerTmpDir,
      vectorStore,
      embedder,
      new StubFileWatcher(),
      fsAdapter,
    );

    const indexerDeps: McpDependencies = {
      fsAdapter,
      vectorStore,
      embedder,
      workflow,
      vaultRoot: indexerTmpDir,
      indexer,
    };

    const server = createMcpServer(indexerDeps);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    indexerClient = new Client({ name: "test-indexer-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await indexerClient.connect(clientTransport);

    indexerCleanup = async () => {
      await indexerClient.close();
      await server.close();
    };
  });

  afterEach(async () => {
    await indexerCleanup();
    await fs.rm(indexerTmpDir, { recursive: true, force: true });
  });

  it("includes indexing health fields in status response", async () => {
    const result = await indexerClient.callTool({
      name: "system",
      arguments: { action: "status" },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text);

    expect(parsed.result.indexingState).toBeDefined();
    expect(["idle", "indexing", "watching", "error"]).toContain(parsed.result.indexingState);
    expect(parsed.result.watcherState).toBeDefined();
    expect(["stopped", "active"]).toContain(parsed.result.watcherState);
    expect(typeof parsed.result.queueDepth).toBe("number");
    expect(typeof parsed.result.failureCount).toBe("number");
    expect(typeof parsed.result.indexedDocuments).toBe("number");
  });

  it("returns idle indexingState when watcher is not started", async () => {
    const result = await indexerClient.callTool({
      name: "system",
      arguments: { action: "status" },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text);

    expect(parsed.result.indexingState).toBe("idle");
    expect(parsed.result.watcherState).toBe("stopped");
    expect(parsed.result.failureCount).toBe(0);
    expect(parsed.result.lastFailure).toBeNull();
  });

  it("does not expose vault root absolute path", async () => {
    const result = await indexerClient.callTool({
      name: "system",
      arguments: { action: "status" },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text);

    expect(parsed.result.vaultRoot).toBeUndefined();
    expect(JSON.stringify(parsed.result)).not.toContain(indexerTmpDir);
  });
});

// ── system tool — overview actions (contract-first TDD) ───────────

describe("MCP Server — system tool — overview actions", () => {
  it("overview_status returns missing when no overview file exists", async () => {
    const result = await client.callTool({
      name: "system",
      arguments: { action: "overview_status" },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text) as {
      result: { status: string; managed_by: string | null; updated_at: string | null };
    };

    expect(parsed.result.status).toBe("missing");
    expect(parsed.result.managed_by).toBeNull();
    expect(parsed.result.updated_at).toBeNull();
  });

  it("overview_status returns present with frontmatter metadata when overview file exists", async () => {
    // Write a schema v3 overview file first
    const overviewContent = [
      "---",
      "schema_version: 3",
      "vault_scope: 'test vault'",
      "updated_at: '2024-01-01T00:00:00.000Z'",
      "managed_by: host",
      "---",
      "",
      "# Vault Overview",
      "",
      "This is a test vault.",
    ].join("\n");
    await fs.mkdir(path.join(tmpDir, "meta"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "meta/overview.md"), overviewContent);

    const result = await client.callTool({
      name: "system",
      arguments: { action: "overview_status" },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text) as {
      result: { status: string; managed_by: string | null; updated_at: string | null };
    };

    expect(parsed.result.status).toBe("present");
    expect(parsed.result.managed_by).toBe("host");
    expect(parsed.result.updated_at).toBe("2024-01-01T00:00:00.000Z");
  });

  it("prepare_overview returns structural vault data without writing any files", async () => {
    const filesBefore = await fs.readdir(tmpDir, { recursive: true });

    const result = await client.callTool({
      name: "system",
      arguments: { action: "prepare_overview" },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text) as {
      result: {
        fileCount: number;
        directories: string[];
        tags: string[];
        recentTitles: string[];
      };
    };

    // Verify structural data is returned
    expect(typeof parsed.result.fileCount).toBe("number");
    expect(parsed.result.fileCount).toBeGreaterThan(0);
    expect(Array.isArray(parsed.result.directories)).toBe(true);
    expect(Array.isArray(parsed.result.tags)).toBe(true);
    expect(Array.isArray(parsed.result.recentTitles)).toBe(true);

    // Verify no new files were written
    const filesAfter = await fs.readdir(tmpDir, { recursive: true });
    expect(filesAfter.length).toBe(filesBefore.length);
  });

  it("prepare_overview includes known directories from seeded vault", async () => {
    const result = await client.callTool({
      name: "system",
      arguments: { action: "prepare_overview" },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text) as {
      result: { fileCount: number; directories: string[]; tags: string[]; recentTitles: string[] };
    };

    // The seeded vault has hello.md and daily/2024-01-01.md
    expect(parsed.result.fileCount).toBe(2);
    expect(parsed.result.directories).toContain("daily");
  });

  it("save_overview writes overview to meta/overview.md with schema_version:3 frontmatter", async () => {
    const overviewText = "This vault contains notes about MCP and markdown tooling.";
    const scopeText = "MCP server architecture and markdown tooling notes.";

    const result = await client.callTool({
      name: "system",
      arguments: { action: "save_overview", overview: overviewText, scope: scopeText },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text) as {
      result: { saved: boolean; path: string };
    };

    expect(parsed.result.saved).toBe(true);
    expect(parsed.result.path).toBe("meta/overview.md");

    // Verify the file was actually written
    const written = await fs.readFile(path.join(tmpDir, "meta/overview.md"), "utf-8");
    expect(written).toContain("schema_version: 3");
    expect(written).toContain("vault_scope: MCP server architecture and markdown tooling notes.");
    expect(written).not.toContain("overview:");
    expect(written).toContain(overviewText);
  });

  it("save_overview: after save, overview_status returns present", async () => {
    const overviewText = "A vault for testing the save_overview action.";
    const scopeText = "Testing scope.";

    await client.callTool({
      name: "system",
      arguments: { action: "save_overview", overview: overviewText, scope: scopeText },
    });

    const statusResult = await client.callTool({
      name: "system",
      arguments: { action: "overview_status" },
    });
    const content = statusResult.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text) as {
      result: { status: string; managed_by: string | null; updated_at: string | null };
    };

    expect(parsed.result.status).toBe("present");
    expect(parsed.result.managed_by).toBe("host");
    expect(parsed.result.updated_at).not.toBeNull();
  });
});

describe("MCP Server — tool schema and description pins", () => {
  it("edit tool description mentions dryRun", async () => {
    const result = await client.listTools();
    const editTool = result.tools.find((t) => t.name === "edit");
    expect(editTool?.description).toContain("dryRun");
  });

  it("edit tool description mentions batch operations", async () => {
    const result = await client.listTools();
    const editTool = result.tools.find((t) => t.name === "edit");
    expect(editTool?.description).toContain("batch");
  });

  it("edit tool inputSchema includes dryRun field", async () => {
    const result = await client.listTools();
    const editTool = result.tools.find((t) => t.name === "edit");
    const schema = editTool?.inputSchema as { properties?: Record<string, unknown> } | undefined;
    expect(schema?.properties).toHaveProperty("dryRun");
  });

  it("edit tool inputSchema includes operations field for batch", async () => {
    const result = await client.listTools();
    const editTool = result.tools.find((t) => t.name === "edit");
    const schema = editTool?.inputSchema as { properties?: Record<string, unknown> } | undefined;
    expect(schema?.properties).toHaveProperty("operations");
  });

  it("view tool description mentions outline action", async () => {
    const result = await client.listTools();
    const viewTool = result.tools.find((t) => t.name === "view");
    expect(viewTool?.description).toContain("outline");
  });

  it("view tool description mentions bulk_read", async () => {
    const result = await client.listTools();
    const viewTool = result.tools.find((t) => t.name === "view");
    expect(viewTool?.description).toContain("bulk_read");
  });

  it("view tool inputSchema includes path field", async () => {
    const result = await client.listTools();
    const viewTool = result.tools.find((t) => t.name === "view");
    const schema = viewTool?.inputSchema as { properties?: Record<string, unknown> } | undefined;
    expect(schema?.properties).toHaveProperty("path");
  });

  it("view tool inputSchema includes directory field", async () => {
    const result = await client.listTools();
    const viewTool = result.tools.find((t) => t.name === "view");
    const schema = viewTool?.inputSchema as { properties?: Record<string, unknown> } | undefined;
    expect(schema?.properties).toHaveProperty("directory");
  });

  it("workflow tool description mentions optional session state", async () => {
    const result = await client.listTools();
    const wfTool = result.tools.find((t) => t.name === "workflow");
    expect(wfTool?.description).toContain("optional");
  });

  it("system tool description mentions reindex", async () => {
    const result = await client.listTools();
    const sysTool = result.tools.find((t) => t.name === "system");
    expect(sysTool?.description).toContain("reindex");
  });

  it("view outline with file path returns HeadingInfo array (file mode pinned)", async () => {
    const mdPath = `${tmpDir}/pin-outline.md`;
    await fs.writeFile(mdPath, "# Title\n\n## Section\n\nContent.\n");
    const result = await client.callTool({
      name: "view",
      arguments: { action: "outline", path: "pin-outline.md" },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text) as { result: Array<{ title: string; depth: number }> };
    expect(Array.isArray(parsed.result)).toBe(true);
    expect(parsed.result[0]).toHaveProperty("title");
    expect(parsed.result[0]).toHaveProperty("depth");
  });

  it("view outline with directory defaults to a summary tree with counts", async () => {
    await fs.mkdir(`${tmpDir}/dir-outline`, { recursive: true });
    await fs.writeFile(`${tmpDir}/dir-outline/alpha.md`, "# Alpha\n\n## Sub\n\nContent.\n");
    await fs.writeFile(`${tmpDir}/dir-outline/beta.md`, "# Beta\n\nContent.\n");
    const result = await client.callTool({
      name: "view",
      arguments: { action: "outline", directory: "dir-outline" },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text) as {
      result: { mode: string; totalFiles: number; truncated: boolean; folders: unknown[] };
    };
    expect(parsed.result.mode).toBe("summary");
    expect(parsed.result.totalFiles).toBe(2);
    expect(parsed.result.truncated).toBe(false);
    expect(Array.isArray(parsed.result.folders)).toBe(true);
  });

  it("view outline with mode='files' returns per-file heading arrays", async () => {
    await fs.mkdir(`${tmpDir}/dir-outline`, { recursive: true });
    await fs.writeFile(`${tmpDir}/dir-outline/alpha.md`, "# Alpha\n\n## Sub\n\nContent.\n");
    await fs.writeFile(`${tmpDir}/dir-outline/beta.md`, "# Beta\n\nContent.\n");
    const result = await client.callTool({
      name: "view",
      arguments: { action: "outline", directory: "dir-outline", mode: "files" },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text) as {
      result: {
        mode: string;
        totalFiles: number;
        truncated: boolean;
        files: Array<{ path: string; headings: Array<{ title: string; depth: number }> }>;
      };
    };
    expect(parsed.result.mode).toBe("files");
    expect(parsed.result.totalFiles).toBe(2);
    expect(parsed.result.truncated).toBe(false);
    expect(parsed.result.files).toHaveLength(2);
    expect(parsed.result.files[0]).toHaveProperty("path");
    expect(parsed.result.files[0]).toHaveProperty("headings");
    expect(Array.isArray(parsed.result.files[0]!.headings)).toBe(true);
    expect(parsed.result.files[0]!.headings[0]).toHaveProperty("title");
  });

  it("view outline files mode honours limit/offset and reports truncated", async () => {
    await fs.mkdir(`${tmpDir}/dir-outline-page`, { recursive: true });
    for (const name of ["a", "b", "c"]) {
      await fs.writeFile(`${tmpDir}/dir-outline-page/${name}.md`, `# ${name}\n`);
    }
    const result = await client.callTool({
      name: "view",
      arguments: { action: "outline", directory: "dir-outline-page", mode: "files", limit: 1, offset: 1 },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text) as {
      result: { totalFiles: number; returned: number; truncated: boolean; files: Array<{ path: string }> };
    };
    expect(parsed.result.totalFiles).toBe(3);
    expect(parsed.result.returned).toBe(1);
    expect(parsed.result.truncated).toBe(true);
    expect(parsed.result.files[0]!.path).toBe("dir-outline-page/b.md");
  });

  it("view outline with empty directory returns error", async () => {
    await fs.mkdir(`${tmpDir}/dir-outline-empty`, { recursive: true });
    const result = await client.callTool({
      name: "view",
      arguments: { action: "outline", directory: "dir-outline-empty" },
    });
    expect(result.isError).toBe(true);
  });
});

describe("MCP Server — structured edit response fields", () => {
  it("single append returns changed=true, operation, and path fields", async () => {
    const mdPath = `${tmpDir}/structured-edit.md`;
    await fs.writeFile(mdPath, "# Hello\n\nOriginal content.\n");

    const result = await client.callTool({
      name: "edit",
      arguments: {
        path: "structured-edit.md",
        operation: "append",
        content: "Appended line.",
      },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text) as {
      result: { message: string; changed?: boolean; operation?: string; path?: string };
    };
    expect(parsed.result.changed).toBe(true);
    expect(parsed.result.operation).toBe("append");
    expect(parsed.result.path).toBe("structured-edit.md");
  });

  it("single replace returns changed=true", async () => {
    const mdPath = `${tmpDir}/replace-test.md`;
    await fs.writeFile(mdPath, "# Title\n\n## Section\n\nOld content.\n");

    const result = await client.callTool({
      name: "edit",
      arguments: {
        path: "replace-test.md",
        operation: "replace",
        heading: "Section",
        headingDepth: 2,
        content: "New content.",
      },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text) as {
      result: { changed?: boolean; operation?: string; path?: string };
    };
    expect(parsed.result.changed).toBe(true);
    expect(parsed.result.operation).toBe("replace");
    expect(parsed.result.path).toBe("replace-test.md");
  });

  it("returnContent=file returns fileContent in response", async () => {
    const mdPath = `${tmpDir}/rc-file.md`;
    await fs.writeFile(mdPath, "# File\n\nContent here.\n");

    const result = await client.callTool({
      name: "edit",
      arguments: {
        path: "rc-file.md",
        operation: "append",
        content: "Extra line.",
        returnContent: "file",
      },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text) as {
      result: { fileContent?: string; changed?: boolean };
    };
    expect(typeof parsed.result.fileContent).toBe("string");
    expect(parsed.result.fileContent).toContain("Extra line.");
    expect(parsed.result.changed).toBe(true);
  });

  it("returnContent=section returns modifiedSection in response", async () => {
    const mdPath = `${tmpDir}/rc-section.md`;
    await fs.writeFile(mdPath, "# Doc\n\nDoc content.\n");

    const result = await client.callTool({
      name: "edit",
      arguments: {
        path: "rc-section.md",
        operation: "prepend",
        content: "Prepended.",
        returnContent: "section",
      },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text) as {
      result: { modifiedSection?: string };
    };
    expect(typeof parsed.result.modifiedSection).toBe("string");
  });

  it("edit tool inputSchema includes returnContent field", async () => {
    const result = await client.listTools();
    const editTool = result.tools.find((t) => t.name === "edit");
    const schema = editTool?.inputSchema as { properties?: Record<string, unknown> } | undefined;
    expect(schema?.properties).toHaveProperty("returnContent");
  });
});

// ── edit tool: batch required-content validation ──────────────────

describe("edit tool — batch required-content validation", () => {
  it("rejects string_replace without content and does not corrupt the file", async () => {
    const original = await fs.readFile(path.join(tmpDir, "hello.md"), "utf-8");
    const result = await client.callTool({
      name: "edit",
      arguments: {
        operations: [
          { path: "hello.md", operation: "string_replace", searchText: "Welcome to the vault." },
        ],
      },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text) as { error?: string; message?: string };
    expect(parsed.error).toBe("INVALID_ARGUMENT");
    expect(parsed.message).toContain("content");

    const after = await fs.readFile(path.join(tmpDir, "hello.md"), "utf-8");
    expect(after).toBe(original);
    expect(after).not.toContain("undefined");
  });
});

// ── view tool: frontmatter YAML errors ────────────────────────────

describe("view tool — frontmatter YAML errors", () => {
  it("frontmatter_get surfaces parse details instead of 'Internal error occurred'", async () => {
    await fs.writeFile(
      path.join(tmpDir, "broken.md"),
      "---\ntags: [mcp, guide\nstatus: draft\n---\n\n# Broken\n\nBody.\n",
    );
    const result = await client.callTool({
      name: "view",
      arguments: { action: "frontmatter_get", path: "broken.md" },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const text = content[0]!.text;
    expect(text).not.toContain("Internal error occurred");
    const parsed = JSON.parse(text) as { error?: string; message?: string };
    expect(parsed.error).toBe("INVALID_FRONTMATTER_YAML");
    expect(parsed.message).toContain("broken.md");
    // js-yaml reports the position as (line:column), e.g. "(2:1)".
    expect(parsed.message!).toMatch(/\(\d+:\d+\)/);
  });
});

// ── view tool: directory paths give a clear error with hints ─────

describe("view tool — directory paths give a clear error with hints", () => {
  it("search with a directory path searches inside it and warns (P2-8)", async () => {
    // Two chunks so the lexical scorer has an IDF signal in this directory.
    await fs.writeFile(
      path.join(tmpDir, "daily/2024-01-02.md"),
      "# Daily Two\n\nAlpha beta gamma delta.\n\n## Transport\n\ntransport options for MCP servers in depth.\n",
    );
    const result = await client.callTool({
      name: "view",
      arguments: { action: "search", path: "daily", query: "transport" },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    const parsed = JSON.parse(text) as {
      result: { directory?: string; warnings?: string[]; results: Array<{ filePath: string }> };
    };
    expect(parsed.result.directory).toBe("daily");
    expect(parsed.result.warnings).toHaveLength(1);
    expect(parsed.result.results.length).toBeGreaterThan(0);
    expect(
      parsed.result.results.every((r) => r.filePath.startsWith("daily/")),
    ).toBe(true);
  });

  it("outline with a directory path returns the directory outline with a warning (B2)", async () => {
    const result = await client.callTool({
      name: "view",
      arguments: { action: "outline", path: "daily" },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    const parsed = JSON.parse(text) as {
      result: { directory: string; warnings: string[]; totalFiles: number; mode: string };
    };
    expect(parsed.result.directory).toBe("daily");
    expect(parsed.result.warnings).toHaveLength(1);
    expect(parsed.result.totalFiles).toBe(1);
    expect(parsed.result.mode).toBe("summary");
  });

  it("read with a directory path is rejected with PATH_IS_DIRECTORY", async () => {
    const result = await client.callTool({
      name: "view",
      arguments: { action: "read", path: "daily" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    const parsed = JSON.parse(text) as { error?: string; message?: string };
    expect(parsed.error).toBe("PATH_IS_DIRECTORY");
  });
});

// ── edit tool: string_replace diagnostics (A1) ────────────────────

describe("edit tool — string_replace diagnostics (A1)", () => {
  it("reports nearest line + line_replace hint, leaves the file intact, then succeeds", async () => {
    const body = "# Title\n\nAlpha line one.\nTarget line with [[Agent/x]] and stuff.\nOmega line.\n";
    await fs.writeFile(path.join(tmpDir, "diag.md"), body);

    const result = await client.callTool({
      name: "edit",
      arguments: {
        path: "diag.md",
        operation: "string_replace",
        searchText: "Target line with [[Agent/x]] and other stuff",
        content: "replacement",
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    const parsed = JSON.parse(text) as { error?: string; message?: string };
    expect(parsed.error).toBe("FREEFORM_EDIT_FAILED");
    expect(parsed.message).toContain("nearest line 4");
    expect(parsed.message).toContain("line_replace startLine=4 endLine=4");
    expect(parsed.message).toContain("sha256=");

    // File must not be modified by the failed attempt.
    expect(await fs.readFile(path.join(tmpDir, "diag.md"), "utf-8")).toBe(body);

    // Second call: the suggested line_replace works.
    const lineResult = await client.callTool({
      name: "edit",
      arguments: {
        path: "diag.md",
        operation: "line_replace",
        startLine: 4,
        endLine: 4,
        content: "Replaced line.",
      },
    });
    const lineParsed = JSON.parse(
      (lineResult.content as Array<{ type: string; text: string }>)[0]!.text,
    ) as { result: { changed?: boolean } };
    expect(lineParsed.result.changed).toBe(true);
    expect(await fs.readFile(path.join(tmpDir, "diag.md"), "utf-8")).toContain("Replaced line.");
  });
});

// ── view.read: line numbers and stat (A2) ─────────────────────────

describe("view.read — line numbers and stat (A2)", () => {
  it("prefixes line numbers when lineNumbers=true", async () => {
    const result = await client.callTool({
      name: "view",
      arguments: { action: "read", path: "hello.md", lineNumbers: true },
    });
    const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text) as {
      result: { path: string; content: string };
    };
    expect(parsed.result.path).toBe("hello.md");
    expect(parsed.result.content).toContain("1: ---");
    expect(parsed.result.content).toContain("5: # Hello World");
  });

  it("includes a file fingerprint when stat=true", async () => {
    const result = await client.callTool({
      name: "view",
      arguments: { action: "read", path: "hello.md", stat: true },
    });
    const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text) as {
      result: { stat: { sizeBytes: number; mtime: string; sha256: string } };
    };
    expect(parsed.result.stat.sha256).toMatch(/^[0-9a-f]{12}$/);
    expect(typeof parsed.result.stat.sizeBytes).toBe("number");
    expect(typeof parsed.result.stat.mtime).toBe("string");
  });

  it("still returns a raw string when no read options are requested", async () => {
    const result = await client.callTool({
      name: "view",
      arguments: { action: "read", path: "hello.md" },
    });
    const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text);
    expect(typeof parsed.result).toBe("string");
  });
});

// ── view.search: directory and whole-vault scope (B1) ─────────────

describe("view.search — directory and whole-vault scope (B1)", () => {
  it("searches the whole vault when path is omitted", async () => {
    const result = await client.callTool({
      name: "view",
      arguments: { action: "search", query: "learned about MCP" },
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text) as {
      result: Array<{ filePath: string }>;
    };
    expect(Array.isArray(parsed.result)).toBe(true);
    expect(parsed.result.some((r) => r.filePath === "daily/2024-01-01.md")).toBe(true);
  });

  it("scopes search to a directory", async () => {
    const result = await client.callTool({
      name: "view",
      arguments: { action: "search", query: "learned about MCP", directory: "daily" },
    });
    const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text) as {
      result: Array<{ filePath: string }>;
    };
    expect(parsed.result.length).toBeGreaterThan(0);
    expect(parsed.result.every((r) => r.filePath.startsWith("daily/"))).toBe(true);
  });

  it("still supports file-scoped search when path is given", async () => {
    const result = await client.callTool({
      name: "view",
      arguments: { action: "search", query: "Getting Started", path: "hello.md" },
    });
    const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text) as {
      result: unknown[];
    };
    expect(parsed.result.length).toBeGreaterThan(0);
  });

  it("errors when query is missing even without path", async () => {
    const result = await client.callTool({ name: "view", arguments: { action: "search" } });
    expect(result.isError).toBe(true);
  });
});

// ── edit tool: single-call required content (D1) ──────────────────

describe("edit tool — single-call required content (D1)", () => {
  it("rejects a single string_replace without content and does not touch the file", async () => {
    const original = await fs.readFile(path.join(tmpDir, "hello.md"), "utf-8");
    const result = await client.callTool({
      name: "edit",
      arguments: { path: "hello.md", operation: "string_replace", searchText: "Welcome to the vault." },
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text) as {
      error?: string;
    };
    expect(parsed.error).toBe("INVALID_ARGUMENT");
    expect(await fs.readFile(path.join(tmpDir, "hello.md"), "utf-8")).toBe(original);
  });
});

// ── edit tool: expectLine guard (A3/D3) ───────────────────────────

describe("edit tool — line_replace expectLine guard (A3)", () => {
  it("succeeds when expectLine matches", async () => {
    await fs.writeFile(path.join(tmpDir, "expect.md"), "# T\n\nAlpha line.\nBeta line.\n");

    const result = await client.callTool({
      name: "edit",
      arguments: {
        path: "expect.md",
        operation: "line_replace",
        startLine: 3,
        endLine: 3,
        content: "Replaced.",
        expectLine: "Alpha line",
      },
    });

    const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text) as {
      result: { changed?: boolean };
    };
    expect(parsed.result.changed).toBe(true);
    expect(await fs.readFile(path.join(tmpDir, "expect.md"), "utf-8")).toContain("Replaced.");
  });

  it("fails with the actual line content when expectLine drifts", async () => {
    await fs.writeFile(path.join(tmpDir, "expect2.md"), "# T\n\nAlpha line.\nBeta line.\n");

    const result = await client.callTool({
      name: "edit",
      arguments: {
        path: "expect2.md",
        operation: "line_replace",
        startLine: 3,
        endLine: 3,
        content: "Replaced.",
        expectLine: "Totally different",
      },
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text) as {
      error?: string;
      message?: string;
    };
    expect(parsed.error).toBe("FREEFORM_EDIT_FAILED");
    expect(parsed.message).toContain("Line 3");
    expect(parsed.message).toContain("Alpha line.");
    expect(await fs.readFile(path.join(tmpDir, "expect2.md"), "utf-8")).toContain("Alpha line.");
  });
});

// ── view.outline: directory path fallback (B2) ────────────────────

describe("view.outline — directory path fallback (B2)", () => {
  it("outlines a directory passed via path with a warning instead of failing", async () => {
    await fs.mkdir(path.join(tmpDir, "outdir"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "outdir/a.md"), "# A\n");
    await fs.writeFile(path.join(tmpDir, "outdir/b.md"), "# B\n");

    const result = await client.callTool({
      name: "view",
      arguments: { action: "outline", path: "outdir" },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text) as {
      result: { directory: string; warnings: string[]; totalFiles: number; mode: string };
    };
    expect(parsed.result.directory).toBe("outdir");
    expect(parsed.result.warnings).toHaveLength(1);
    expect(parsed.result.totalFiles).toBe(2);
    expect(parsed.result.mode).toBe("summary");
  });
});

// ── view path errors carry hints (B3) ─────────────────────────────

describe("view tool — path error hints (B3)", () => {
  it("NOTE_NOT_FOUND includes nearest-path suggestions", async () => {
    const result = await client.callTool({
      name: "view",
      arguments: { action: "read", path: "helo.md" },
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text) as {
      error?: string;
      hint?: string;
    };
    expect(parsed.error).toBe("NOTE_NOT_FOUND");
    expect(parsed.hint).toBeDefined();
    expect(parsed.hint).toContain("hello.md");
  });

  it("PATH_IS_DIRECTORY includes a hint", async () => {
    const result = await client.callTool({
      name: "view",
      arguments: { action: "read", path: "daily" },
    });
    const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text) as {
      error?: string;
      hint?: string;
    };
    expect(parsed.error).toBe("PATH_IS_DIRECTORY");
    expect(parsed.hint).toBeDefined();
  });
});

// ── frontmatter_set is byte-preserving (C1) ───────────────────────

describe("edit tool — byte-preserving frontmatter_set (C1)", () => {
  it("leaves the body (dash bullets, underscores) untouched", async () => {
    const body = "# Title\n\n- item one\n- item two\n\ncall send_mail() now\n";
    await fs.writeFile(path.join(tmpDir, "fm.md"), `---\ntitle: T\n---\n\n${body}`);

    const result = await client.callTool({
      name: "edit",
      arguments: { path: "fm.md", operation: "frontmatter_set", content: '{"status":"draft"}' },
    });

    expect(result.isError).toBeFalsy();
    const after = await fs.readFile(path.join(tmpDir, "fm.md"), "utf-8");
    expect(after).toContain("status: draft");
    expect(after).toContain(body);
    expect(after).not.toContain("* item one");
    expect(after).not.toContain("send\\_mail");
  });
});

// ── dryRun determinism (D4) ───────────────────────────────────────

describe("edit tool — dryRun determinism (D4)", () => {
  it("dryRun preview matches the diff of the actually applied change", async () => {
    const original = "# T\n\nSome text here.\n";
    await fs.writeFile(path.join(tmpDir, "dry.md"), original);

    const dryResult = await client.callTool({
      name: "edit",
      arguments: {
        path: "dry.md",
        operation: "string_replace",
        searchText: "Some text here.",
        content: "Replaced text.",
        dryRun: true,
      },
    });
    const dryParsed = JSON.parse(
      (dryResult.content as Array<{ type: string; text: string }>)[0]!.text,
    ) as { result: { diff?: string } };
    expect(dryParsed.result.diff).toBeDefined();
    // dryRun must not write.
    expect(await fs.readFile(path.join(tmpDir, "dry.md"), "utf-8")).toBe(original);

    const realResult = await client.callTool({
      name: "edit",
      arguments: {
        path: "dry.md",
        operation: "string_replace",
        searchText: "Some text here.",
        content: "Replaced text.",
      },
    });
    expect(realResult.isError).toBeFalsy();
    const applied = await fs.readFile(path.join(tmpDir, "dry.md"), "utf-8");
    expect(applied).toContain("Replaced text.");

    // Determinism: the preview equals the diff of the real before/after.
    const expected = new UnifiedDiffService().generateDiff(original, applied, "dry.md");
    expect(dryParsed.result.diff).toBe(expected);
  });
});

// ── byte-preserving heading edits (C1) ────────────────────────────

describe("edit tool — byte-preserving heading edits (C1)", () => {
  it("append under a heading leaves other sections byte-for-byte intact", async () => {
    const other = "- dash item one\n- dash item two\n\ncall send_mail() now\n\n| a | b |\n| - | - |\n";
    const source = `# Doc\n\n## Target\n\nOld target body.\n\n## Other\n\n${other}`;
    await fs.writeFile(path.join(tmpDir, "bp.md"), source);

    const result = await client.callTool({
      name: "edit",
      arguments: {
        path: "bp.md",
        operation: "append",
        heading: "Target",
        headingDepth: 2,
        content: "Added line.",
      },
    });
    expect(result.isError).toBeFalsy();

    const after = await fs.readFile(path.join(tmpDir, "bp.md"), "utf-8");
    expect(after).toContain("Added line.");
    // The untouched section keeps its exact formatting.
    expect(after.slice(after.indexOf("## Other"))).toBe(`## Other\n\n${other}`);
    expect(after).not.toContain("* dash item");
    expect(after).not.toContain("send\\_mail");
    expect(after).toContain("| a | b |");
  });

  it("replace preserves the heading and other sections", async () => {
    const source = "# Doc\n\n## Target\n\nOld body.\n\n## Other\n\nkeep_this_underscore\n";
    await fs.writeFile(path.join(tmpDir, "bp2.md"), source);

    const result = await client.callTool({
      name: "edit",
      arguments: {
        path: "bp2.md",
        operation: "replace",
        heading: "Target",
        headingDepth: 2,
        content: "New body.",
      },
    });
    expect(result.isError).toBeFalsy();

    const after = await fs.readFile(path.join(tmpDir, "bp2.md"), "utf-8");
    expect(after).toContain("## Target");
    expect(after).toContain("New body.");
    expect(after).not.toContain("Old body.");
    expect(after).toContain("keep_this_underscore");
  });
});

// ── view.glob (B4) ────────────────────────────────────────────────

describe("view.glob (B4)", () => {
  it("lists paths matching a glob pattern", async () => {
    await fs.mkdir(path.join(tmpDir, "gdir", "deep"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "gdir/a.md"), "# A\n");
    await fs.writeFile(path.join(tmpDir, "gdir/deep/b.md"), "# B\n");

    const result = await client.callTool({
      name: "view",
      arguments: { action: "glob", pattern: "gdir/**/*.md" },
    });

    const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text) as {
      result: { files: string[]; totalFiles: number; truncated: boolean };
    };
    expect(parsed.result.files).toEqual(["gdir/a.md", "gdir/deep/b.md"]);
    expect(parsed.result.totalFiles).toBe(2);
    expect(parsed.result.truncated).toBe(false);
  });

  it("errors when pattern is missing", async () => {
    const result = await client.callTool({ name: "view", arguments: { action: "glob" } });
    expect(result.isError).toBe(true);
  });
});

// ── system.selftest (A4) ──────────────────────────────────────────

describe("system.selftest (A4)", () => {
  it("runs the in-vault round-trip and reports PASS", async () => {
    const result = await client.callTool({
      name: "system",
      arguments: { action: "selftest" },
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text) as {
      result: { status: string; steps: Array<{ ok: boolean }> };
    };
    expect(parsed.result.status).toBe("PASS");
    expect(parsed.result.steps.every((step) => step.ok)).toBe(true);
  });
});

// ── system.normalize_links (C3) ───────────────────────────────────

describe("system.normalize_links (C3)", () => {
  it("previews by default and does not write", async () => {
    const original = "# T\n\n\\[\\[Agent/a]] and \\_x\n";
    await fs.writeFile(path.join(tmpDir, "links.md"), original);

    const result = await client.callTool({
      name: "system",
      arguments: { action: "normalize_links", path: "links.md" },
    });

    const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text) as {
      result: { dryRun: boolean; replacements: number; diff?: string };
    };
    expect(parsed.result.dryRun).toBe(true);
    expect(parsed.result.replacements).toBeGreaterThan(0);
    expect(parsed.result.diff).toBeDefined();
    expect(await fs.readFile(path.join(tmpDir, "links.md"), "utf-8")).toBe(original);
  });

  it("writes canonical links when dryRun=false", async () => {
    await fs.writeFile(path.join(tmpDir, "links2.md"), "# T\n\n\\[\\[Agent/a]]\n");

    await client.callTool({
      name: "system",
      arguments: { action: "normalize_links", path: "links2.md", dryRun: false },
    });

    const after = await fs.readFile(path.join(tmpDir, "links2.md"), "utf-8");
    expect(after).toContain("[[Agent/a]]");
    expect(after).not.toContain("\\[\\[");
  });
});

// ── vault create: content sanity warnings (C2) ────────────────────

describe("vault create — content sanity warnings (C2)", () => {
  it("returns warnings for model-escape artifacts", async () => {
    const result = await client.callTool({
      name: "vault",
      arguments: {
        action: "create",
        path: "warn.md",
        content: "foo\\nbar and &#x6E;_&#x434;о\n",
      },
    });
    const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text) as {
      result: { message: string; warnings: string[] };
    };
    expect(parsed.result.message).toContain("created");
    expect(parsed.result.warnings.length).toBeGreaterThan(0);
  });

  it("returns a plain string for clean content", async () => {
    const result = await client.callTool({
      name: "vault",
      arguments: { action: "create", path: "clean.md", content: "# Clean\n" },
    });
    const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text);
    expect(typeof parsed.result).toBe("string");
  });
});

// ── view.read: raw round-trip (C4) ────────────────────────────────

describe("view.read — raw round-trip (C4)", () => {
  it("returns content byte-for-byte", async () => {
    const raw =
      "---\r\ntitle: X\r\n---\r\n\r\n# H\r\n\r\n\\[\\[Agent/a]] and \\_x and  two  spaces\r\n";
    await fs.writeFile(path.join(tmpDir, "raw.md"), raw);

    const result = await client.callTool({
      name: "view",
      arguments: { action: "read", path: "raw.md" },
    });

    const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text) as {
      result: string;
    };
    expect(parsed.result).toBe(raw);
  });
});

// ── edit tool: escaped-character round-trip (D2) ──────────────────

describe("edit tool — escaped-character round-trip (D2)", () => {
  it("replaces a line with escaped links, underscores, em dash and cyrillic", async () => {
    const line = "Line with \\[\\[Agent/x]] and \\_text and — em dash and кириллица";
    await fs.writeFile(path.join(tmpDir, "d2.md"), `# T\n\n${line}\n\nTail.\n`);

    const result = await client.callTool({
      name: "edit",
      arguments: {
        path: "d2.md",
        operation: "string_replace",
        searchText: line,
        content: "Replaced.",
      },
    });

    expect(result.isError).toBeFalsy();
    const after = await fs.readFile(path.join(tmpDir, "d2.md"), "utf-8");
    expect(after).toContain("Replaced.");
    expect(after).toContain("Tail.");
  });
});

// ── P0-1 / P0-2: byte-preserving document edits and verbatim content ──

/** A note remark-stringify would rewrite: dash bullets, a narrow table,
 *  underscores and an escaped wiki-link. */
const TRICKY_NOTE = [
  "---",
  "title: scratch vault test",
  "---",
  "",
  "- пункт с дефисом",
  "",
  "| a | b |",
  "| --- | --- |",
  "| 1 | 2 |",
  "",
  "Строка с wiki-ссылкой: \\[\\[Agent/_MOC.md]] и подчёркивание send_mail.",
  "",
  "- [ ] задача",
  "",
].join("\n");

async function editTool(args: Record<string, unknown>): Promise<{
  isError?: boolean;
  parsed: { result: Record<string, unknown>; error?: string; message?: string; hint?: string };
}> {
  const result = await client.callTool({ name: "edit", arguments: args });
  const parsed = JSON.parse(
    (result.content as Array<{ type: string; text: string }>)[0]!.text,
  );
  return { ...(result.isError !== undefined ? { isError: result.isError } : {}), parsed };
}

describe("edit — document append/prepend/replace are byte-preserving (P0-1)", () => {
  beforeEach(async () => {
    await fs.writeFile(path.join(tmpDir, "tricky.md"), TRICKY_NOTE);
  });

  it("append without a heading changes only the inserted lines", async () => {
    const content = "- новый пункт с подчёркиванием send_mail";
    const { isError, parsed } = await editTool({
      path: "tricky.md",
      operation: "append",
      content,
    });

    expect(isError).toBeFalsy();
    expect(parsed.result.changed).toBe(true);

    const after = await fs.readFile(path.join(tmpDir, "tricky.md"), "utf-8");
    expect(after).toBe(`${TRICKY_NOTE}\n${content}\n`);
    expect(after).not.toContain("* пункт с дефисом");
    expect(after).not.toContain("| --------- |");
    expect(after).not.toContain("send\\_mail");
    expect(after).not.toContain("Agent/\\_MOC");
  });

  it("append dryRun reports a diff of only the added lines", async () => {
    const content = "Добавленная строка.";
    const { parsed } = await editTool({
      path: "tricky.md",
      operation: "append",
      content,
      dryRun: true,
    });

    const diff = parsed.result.diff as string;
    const added = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    const removed = diff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"));
    expect(added).toHaveLength(2); // the blank separator line + the content
    expect(removed).toHaveLength(0);
    expect(added.some((l) => l.includes("Добавленная строка."))).toBe(true);
  });

  it("prepend inserts after the frontmatter and leaves the rest intact", async () => {
    const content = "> верхняя вставка";
    const { isError } = await editTool({
      path: "tricky.md",
      operation: "prepend",
      content,
    });
    expect(isError).toBeFalsy();

    const after = await fs.readFile(path.join(tmpDir, "tricky.md"), "utf-8");
    expect(after.startsWith("---\ntitle: scratch vault test\n---\n")).toBe(true);
    expect(after).toContain("> верхняя вставка");
    expect(after).toContain("- пункт с дефисом");
    expect(after).not.toContain("* пункт с дефисом");
    expect(after).not.toContain("send\\_mail");
  });

  it("replace with no heading swaps the body and keeps the frontmatter", async () => {
    const { isError } = await editTool({
      path: "tricky.md",
      operation: "replace",
      content: "Новое тело.",
    });
    expect(isError).toBeFalsy();

    const after = await fs.readFile(path.join(tmpDir, "tricky.md"), "utf-8");
    expect(after).toBe("---\ntitle: scratch vault test\n---\n\nНовое тело.\n");
  });

  it("normalize=true still opts into canonical re-serialization", async () => {
    const { isError } = await editTool({
      path: "tricky.md",
      operation: "append",
      content: "- ещё пункт",
      normalize: true,
    });
    expect(isError).toBeFalsy();

    const after = await fs.readFile(path.join(tmpDir, "tricky.md"), "utf-8");
    // The canonical path rewrites dash bullets into `*` — the old behaviour,
    // now only on explicit request.
    expect(after).toContain("* пункт с дефисом");
  });

  it("edit tool inputSchema exposes the normalize flag", async () => {
    const tools = await client.listTools();
    const edit = tools.tools.find((t) => t.name === "edit");
    const schema = edit?.inputSchema as { properties?: Record<string, unknown> } | undefined;
    expect(schema?.properties).toHaveProperty("normalize");
  });
});

describe("edit — inserted content is verbatim (P0-2)", () => {
  it("writes dashes, underscores, pipes and wiki-links exactly as passed", async () => {
    await fs.writeFile(path.join(tmpDir, "verbatim.md"), "# T\n\n## Section\n\nOld.\n");
    const content = "- новый пункт с подчёркиванием send_mail\n- [[Agent/_MOC.md]] и * звёздочка\n| a | b |";

    const { isError } = await editTool({
      path: "verbatim.md",
      operation: "append",
      heading: "Section",
      content,
    });
    expect(isError).toBeFalsy();

    const after = await fs.readFile(path.join(tmpDir, "verbatim.md"), "utf-8");
    expect(after).toContain(content);
    expect(after).not.toContain("send\\_mail");
    expect(after).not.toContain("Agent/\\_MOC");
    expect(after).not.toContain("* новый пункт");
  });
});

// ── P1-4: frontmatter object parameter ────────────────────────────

describe("edit — frontmatter_set accepts a frontmatter object (P1-4)", () => {
  it("works with frontmatter and no content", async () => {
    await fs.writeFile(path.join(tmpDir, "fm.md"), '---\ntitle: "scratch vault test"\n---\n\nBody.\n');

    const { isError, parsed } = await editTool({
      path: "fm.md",
      operation: "frontmatter_set",
      frontmatter: { status: "draft", owner: "sergey" },
    });

    expect(isError).toBeFalsy();
    expect(parsed.result.changed).toBe(true);
    expect(parsed.result.updatedKeys).toEqual([]);
    expect(parsed.result.addedKeys).toEqual(["status", "owner"]);

    const after = await fs.readFile(path.join(tmpDir, "fm.md"), "utf-8");
    expect(after).toBe(
      '---\ntitle: "scratch vault test"\nstatus: draft\nowner: sergey\n---\n\nBody.\n',
    );
  });

  it("still accepts the legacy JSON string in content", async () => {
    await fs.writeFile(path.join(tmpDir, "fm-legacy.md"), "---\ntitle: Hi\n---\n\nBody.\n");

    const { isError } = await editTool({
      path: "fm-legacy.md",
      operation: "frontmatter_set",
      content: '{"status":"draft"}',
    });
    expect(isError).toBeFalsy();

    const after = await fs.readFile(path.join(tmpDir, "fm-legacy.md"), "utf-8");
    expect(after).toContain("status: draft");
  });

  it("errors with a usage example when neither frontmatter nor content is given", async () => {
    await fs.writeFile(path.join(tmpDir, "fm-empty.md"), "---\ntitle: Hi\n---\n\nBody.\n");

    const { isError, parsed } = await editTool({
      path: "fm-empty.md",
      operation: "frontmatter_set",
    });

    expect(isError).toBe(true);
    expect(parsed.error).toBe("INVALID_ARGUMENT");
    expect(parsed.hint).toContain("frontmatter");
  });

  it("explains the payload format when content is not valid JSON", async () => {
    await fs.writeFile(path.join(tmpDir, "fm-bad.md"), "---\ntitle: Hi\n---\n\nBody.\n");

    const { isError, parsed } = await editTool({
      path: "fm-bad.md",
      operation: "frontmatter_set",
      content: "status: draft",
    });

    expect(isError).toBe(true);
    expect(parsed.error).toBe("INVALID_FRONTMATTER_PAYLOAD");
    expect(parsed.hint).toContain("frontmatter");
  });

  it("edit tool inputSchema exposes the frontmatter field (single and batch)", async () => {
    const tools = await client.listTools();
    const edit = tools.tools.find((t) => t.name === "edit");
    const schema = edit?.inputSchema as {
      properties?: Record<string, { items?: { properties?: Record<string, unknown> } }>;
    } | undefined;
    expect(schema?.properties).toHaveProperty("frontmatter");
    expect(schema?.properties?.["operations"]?.items?.properties).toHaveProperty("frontmatter");
  });
});

// ── P1-5: frontmatter_set keeps the style of untouched keys ────────

describe("edit — frontmatter_set preserves key style (P1-5)", () => {
  it("does not strip quotes from other keys", async () => {
    await fs.writeFile(
      path.join(tmpDir, "fm-style.md"),
      '---\ntitle: "scratch vault test"\ntags:\n  - a\n  - b\n---\n\nBody.\n',
    );

    await editTool({
      path: "fm-style.md",
      operation: "frontmatter_set",
      frontmatter: { status: "draft" },
    });

    const after = await fs.readFile(path.join(tmpDir, "fm-style.md"), "utf-8");
    expect(after).toContain('title: "scratch vault test"');
    expect(after).toContain("tags:\n  - a\n  - b");
  });

  it("dryRun diff for a single added key touches only that key", async () => {
    await fs.writeFile(
      path.join(tmpDir, "fm-diff.md"),
      "---\ntitle: Hi\ncount: 3\n---\n\nBody.\n",
    );

    const { parsed } = await editTool({
      path: "fm-diff.md",
      operation: "frontmatter_set",
      frontmatter: { count: 4 },
      dryRun: true,
    });

    const diff = parsed.result.diff as string;
    const changed = diff
      .split("\n")
      .filter((l) => /^[+-]/.test(l) && !/^(---|\+\+\+)/.test(l));
    expect(changed).toEqual(["-count: 3", "+count: 4"]);
  });
});

// ── P0-3: service directories never reach listings or search ──────

describe("service directories are excluded everywhere (P0-3)", () => {
  beforeEach(async () => {
    for (const dir of [".stversions/Встречи", ".trash", ".obsidian"]) {
      await fs.mkdir(path.join(tmpDir, dir), { recursive: true });
    }
    await fs.writeFile(
      path.join(tmpDir, ".stversions/Встречи/2026-09-15~20260915-143824.md"),
      "# Historical\n\nsecret needle content\n",
    );
    await fs.writeFile(path.join(tmpDir, ".trash/deleted.md"), "# Deleted\n\nsecret needle content\n");
  });

  it("vault list does not return service-directory paths", async () => {
    const result = await client.callTool({ name: "vault", arguments: { action: "list" } });
    const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text) as {
      result: { notes: string[] };
    };
    expect(parsed.result.notes.some((p) => p.includes(".stversions"))).toBe(false);
    expect(parsed.result.notes.some((p) => p.includes(".trash"))).toBe(false);
    expect(parsed.result.notes).toContain("hello.md");
  });

  it("vault list of an explicit service directory returns nothing", async () => {
    const result = await client.callTool({
      name: "vault",
      arguments: { action: "list", directory: ".stversions/Встречи" },
    });
    const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text) as {
      result: { notes: string[]; totalFiles: number };
    };
    expect(parsed.result.totalFiles).toBe(0);
    expect(parsed.result.notes).toEqual([]);
  });

  it("vault list includeHidden surfaces them again", async () => {
    const result = await client.callTool({
      name: "vault",
      arguments: { action: "list", includeHidden: true },
    });
    const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text) as {
      result: { notes: string[] };
    };
    expect(parsed.result.notes).toContain(".trash/deleted.md");
  });

  it("view.glob excludes service directories and can include them on request", async () => {
    const scoped = JSON.parse(
      ((await client.callTool({
        name: "view",
        arguments: { action: "glob", pattern: "**/*.md" },
      })).content as Array<{ type: string; text: string }>)[0]!.text,
    ) as { result: { files: string[] } };
    expect(scoped.result.files.some((p) => p.includes(".stversions"))).toBe(false);

    const hidden = JSON.parse(
      ((await client.callTool({
        name: "view",
        arguments: { action: "glob", pattern: "**/*.md", includeHidden: true },
      })).content as Array<{ type: string; text: string }>)[0]!.text,
    ) as { result: { files: string[] } };
    expect(hidden.result.files.some((p) => p.includes(".stversions"))).toBe(true);
  });

  it("view.search does not return service-directory notes", async () => {
    const parsed = JSON.parse(
      ((await client.callTool({
        name: "view",
        arguments: { action: "search", query: "needle" },
      })).content as Array<{ type: string; text: string }>)[0]!.text,
    ) as { result: Array<{ filePath: string }> };
    expect(parsed.result.some((r) => r.filePath.includes(".stversions"))).toBe(false);
    expect(parsed.result.some((r) => r.filePath.includes(".trash"))).toBe(false);
  });

  it("vault overview and vault list agree on the file count", async () => {
    const list = JSON.parse(
      ((await client.callTool({ name: "vault", arguments: { action: "list" } })).content as Array<{ type: string; text: string }>)[0]!.text,
    ) as { result: { totalFiles: number } };
    const overview = JSON.parse(
      ((await client.callTool({ name: "system", arguments: { action: "overview" } })).content as Array<{ type: string; text: string }>)[0]!.text,
    ) as { result: { totalFiles: number } };
    expect(overview.result.totalFiles).toBe(list.result.totalFiles);
  });
});

// ── P1-7: heading depth tolerance ─────────────────────────────────

describe("edit — heading depth tolerance (P1-7)", () => {
  beforeEach(async () => {
    await fs.writeFile(
      path.join(tmpDir, "depths.md"),
      "# Тест\n\nH1 body.\n\n## Раздел\n\nH2 body.\n\n### Глубоко\n\nH3 body.\n",
    );
  });

  it("edits an H1 without an explicit headingDepth and reports resolvedDepth", async () => {
    const { isError, parsed } = await editTool({
      path: "depths.md",
      operation: "append",
      heading: "Тест",
      content: "Добавлено в H1.",
    });

    expect(isError).toBeFalsy();
    expect(parsed.result.resolvedDepth).toBe(1);
    expect(parsed.result.warnings).toBeDefined();
    expect((parsed.result.warnings as string[])[0]).toMatch(/headingDepth 1/);

    const after = await fs.readFile(path.join(tmpDir, "depths.md"), "utf-8");
    expect(after).toContain("# Тест");
    expect(after).toContain("Добавлено в H1.");
    // The H1 section spans the whole document, so nothing else was touched.
    expect(after).toContain("H1 body.");
    expect(after).toContain("H2 body.");
    expect(after).toContain("H3 body.");
  });

  it("replace on an H1 swaps the whole H1 section body", async () => {
    const { isError } = await editTool({
      path: "depths.md",
      operation: "replace",
      heading: "Тест",
      content: "Новое тело H1.",
    });

    expect(isError).toBeFalsy();
    const after = await fs.readFile(path.join(tmpDir, "depths.md"), "utf-8");
    expect(after).toContain("# Тест");
    expect(after).toContain("Новое тело H1.");
    expect(after).not.toContain("H1 body.");
  });

  it("edits an H3 without an explicit headingDepth", async () => {
    const { isError, parsed } = await editTool({
      path: "depths.md",
      operation: "append",
      heading: "Глубоко",
      content: "Добавлено в H3.",
    });

    expect(isError).toBeFalsy();
    expect(parsed.result.resolvedDepth).toBe(3);
  });

  it("does not report resolvedDepth when the heading is at depth 2", async () => {
    const { isError, parsed } = await editTool({
      path: "depths.md",
      operation: "append",
      heading: "Раздел",
      content: "Добавлено в H2.",
    });

    expect(isError).toBeFalsy();
    expect(parsed.result.resolvedDepth).toBeUndefined();
  });

  it("a genuinely missing heading reports HEADING_NOT_FOUND with suggestions", async () => {
    const { isError, parsed } = await editTool({
      path: "depths.md",
      operation: "append",
      heading: "Совершенно другой заголовок",
      content: "x",
    });

    expect(isError).toBe(true);
    expect(parsed.error).toBe("HEADING_NOT_FOUND");
    expect(parsed.hint).toContain("view.outline");
    expect(Array.isArray((parsed as unknown as { suggestions?: string[] }).suggestions)).toBe(true);
  });
});

// ── P1-6 / P2-9: outline and listing limits ───────────────────────

describe("outline and listings report totals and truncation (P1-6, P2-9)", () => {
  beforeEach(async () => {
    await fs.mkdir(path.join(tmpDir, "many", "sub"), { recursive: true });
    for (let i = 0; i < 60; i++) {
      const name = `${String(i).padStart(2, "0")}.md`;
      await fs.writeFile(path.join(tmpDir, "many", name), `# Note ${i}\n`);
    }
    await fs.writeFile(path.join(tmpDir, "many/sub/one.md"), "# Sub\n");
  });

  it("outline on a large directory returns a summary instead of failing", async () => {
    const parsed = JSON.parse(
      ((await client.callTool({
        name: "view",
        arguments: { action: "outline", directory: "many" },
      })).content as Array<{ type: string; text: string }>)[0]!.text,
    ) as { result: { mode: string; totalFiles: number; folders: Array<{ name: string; fileCount: number }> } };

    expect(parsed.result.mode).toBe("summary");
    expect(parsed.result.totalFiles).toBe(61);
    const sub = parsed.result.folders.find((f) => f.name === "sub")!;
    expect(sub.fileCount).toBe(1);
  });

  it("outline mode='files' pages the per-file listing and flags truncation", async () => {
    const parsed = JSON.parse(
      ((await client.callTool({
        name: "view",
        arguments: { action: "outline", directory: "many", mode: "files" },
      })).content as Array<{ type: string; text: string }>)[0]!.text,
    ) as { result: { totalFiles: number; returned: number; truncated: boolean; limit: number } };

    expect(parsed.result.totalFiles).toBe(61);
    expect(parsed.result.limit).toBe(50);
    expect(parsed.result.returned).toBe(50);
    expect(parsed.result.truncated).toBe(true);
  });

  it("outline mode='files' can reach the full listing through limit", async () => {
    const parsed = JSON.parse(
      ((await client.callTool({
        name: "view",
        arguments: { action: "outline", directory: "many", mode: "files", limit: 200 },
      })).content as Array<{ type: string; text: string }>)[0]!.text,
    ) as { result: { totalFiles: number; returned: number; truncated: boolean } };

    expect(parsed.result.returned).toBe(61);
    expect(parsed.result.truncated).toBe(false);
  });

  it("vault list is capped by limit and reports totalFiles/truncated", async () => {
    const parsed = JSON.parse(
      ((await client.callTool({
        name: "vault",
        arguments: { action: "list", limit: 2 },
      })).content as Array<{ type: string; text: string }>)[0]!.text,
    ) as { result: { notes: string[]; totalFiles: number; truncated: boolean; returned: number } };

    expect(parsed.result.notes).toHaveLength(2);
    expect(parsed.result.returned).toBe(2);
    expect(parsed.result.truncated).toBe(true);
    expect(parsed.result.totalFiles).toBeGreaterThan(2);
  });

  it("vault list mode='tree' returns a directory summary with counts", async () => {
    const parsed = JSON.parse(
      ((await client.callTool({
        name: "vault",
        arguments: { action: "list", mode: "tree" },
      })).content as Array<{ type: string; text: string }>)[0]!.text,
    ) as { result: { mode: string; totalFiles: number; folders: Array<{ name: string; totalFiles: number }> } };

    expect(parsed.result.mode).toBe("tree");
    const many = parsed.result.folders.find((f) => f.name === "many")!;
    expect(many.totalFiles).toBe(61);
  });

  it("view.glob supports exclude, sort and limit", async () => {
    const parsed = JSON.parse(
      ((await client.callTool({
        name: "view",
        arguments: { action: "glob", pattern: "**/*.md", exclude: "many/**", sort: "path" },
      })).content as Array<{ type: string; text: string }>)[0]!.text,
    ) as { result: { files: string[]; totalFiles: number; truncated: boolean; exclude: string[] } };

    expect(parsed.result.exclude).toEqual(["many/**"]);
    expect(parsed.result.files.some((p) => p.startsWith("many/"))).toBe(false);
    expect(parsed.result.totalFiles).toBe(parsed.result.files.length);
    expect(parsed.result.truncated).toBe(false);

    const limited = JSON.parse(
      ((await client.callTool({
        name: "view",
        arguments: { action: "glob", pattern: "many/**/*.md", limit: 5 },
      })).content as Array<{ type: string; text: string }>)[0]!.text,
    ) as { result: { files: string[]; totalFiles: number; truncated: boolean } };
    expect(limited.result.files).toHaveLength(5);
    expect(limited.result.truncated).toBe(true);
    expect(limited.result.totalFiles).toBe(61);
  });

  it("view.glob accepts an array of exclude patterns", async () => {
    const parsed = JSON.parse(
      ((await client.callTool({
        name: "view",
        arguments: { action: "glob", pattern: "**/*.md", exclude: ["many/**", "daily/**"] },
      })).content as Array<{ type: string; text: string }>)[0]!.text,
    ) as { result: { files: string[]; exclude: string[] } };

    expect(parsed.result.exclude).toEqual(["many/**", "daily/**"]);
    expect(parsed.result.files.some((p) => p.startsWith("many/") || p.startsWith("daily/"))).toBe(false);
    expect(parsed.result.files).toContain("hello.md");
  });
});

// ── P2-10: batch sanity warnings and delete pruning ───────────────

describe("P2-10 — batch sanity warnings and pruneEmptyDirs", () => {
  it("batch operations surface content-sanity warnings like single edits", async () => {
    await fs.writeFile(path.join(tmpDir, "batch-sanity.md"), "# T\n\nBody.\n");

    const result = await client.callTool({
      name: "edit",
      arguments: {
        operations: [
          {
            path: "batch-sanity.md",
            operation: "append",
            content: "escaped underscore \\_x and entity &#x6E;",
          },
        ],
      },
    });

    const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text) as {
      result: { results: Array<{ warnings?: string[] }> };
    };
    expect(parsed.result.results[0]!.warnings?.length).toBeGreaterThan(0);
  });

  it("batch frontmatter_set accepts a frontmatter object without content", async () => {
    await fs.writeFile(path.join(tmpDir, "batch-fm.md"), "---\ntitle: Hi\n---\n\nBody.\n");

    const result = await client.callTool({
      name: "edit",
      arguments: {
        operations: [
          { path: "batch-fm.md", operation: "frontmatter_set", frontmatter: { status: "draft" } },
        ],
      },
    });

    const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text) as {
      result: { totalSucceeded: number };
    };
    expect(parsed.result.totalSucceeded).toBe(1);
    const after = await fs.readFile(path.join(tmpDir, "batch-fm.md"), "utf-8");
    expect(after).toContain("status: draft");
  });

  it("batch append is byte-preserving too", async () => {
    await fs.writeFile(path.join(tmpDir, "batch-bytes.md"), "# T\n\n- dash\n\nsend_mail\n");

    await client.callTool({
      name: "edit",
      arguments: {
        operations: [{ path: "batch-bytes.md", operation: "append", content: "- added" }],
      },
    });

    const after = await fs.readFile(path.join(tmpDir, "batch-bytes.md"), "utf-8");
    expect(after).toBe("# T\n\n- dash\n\nsend_mail\n\n- added\n");
  });

  it("vault delete with pruneEmptyDirs removes the emptied folder", async () => {
    await fs.mkdir(path.join(tmpDir, "_scratch-nodir"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "_scratch-nodir/note.md"), "x\n");

    await client.callTool({
      name: "vault",
      arguments: { action: "delete", path: "_scratch-nodir/note.md", pruneEmptyDirs: true },
    });

    await expect(fs.stat(path.join(tmpDir, "_scratch-nodir"))).rejects.toThrow();
  });

  it("vault delete without pruneEmptyDirs keeps the folder", async () => {
    await fs.mkdir(path.join(tmpDir, "_keep-nodir"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "_keep-nodir/note.md"), "x\n");

    await client.callTool({
      name: "vault",
      arguments: { action: "delete", path: "_keep-nodir/note.md" },
    });

    await expect(fs.stat(path.join(tmpDir, "_keep-nodir"))).resolves.toBeDefined();
  });
});

// ── P0-3: semantic_search never returns service-directory notes ───

describe("view.semantic_search excludes service directories (P0-3)", () => {
  it("filters a stale service-directory entry from the vector store", async () => {
    const vector = Array.from({ length: 3 }, (_, i) => (i === 0 ? 1 : 0));
    await deps.vectorStore.upsert({
      docPath: ".stversions/Встречи/2026-09-07~20260907-131234.md",
      chunks: [{ chunkId: "root", vector, text: "contrast management secret", headingPath: [] }],
    });
    await deps.vectorStore.upsert({
      docPath: "Встречи/2026-09-07.md",
      chunks: [{ chunkId: "root", vector, text: "contract management notes", headingPath: [] }],
    });

    const result = await client.callTool({
      name: "view",
      arguments: { action: "semantic_search", query: "contract management" },
    });
    const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text) as {
      result: Array<{ docPath: string }>;
    };

    expect(parsed.result.length).toBeGreaterThan(0);
    expect(parsed.result.some((r) => r.docPath.includes(".stversions"))).toBe(false);
    expect(parsed.result.some((r) => r.docPath === "Встречи/2026-09-07.md")).toBe(true);
  });
});
