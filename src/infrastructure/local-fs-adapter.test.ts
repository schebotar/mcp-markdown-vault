import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { LocalFileSystemAdapter } from "./local-fs-adapter.js";
import {
  NoteNotFoundError,
  NoteAlreadyExistsError,
  PathTraversalError,
  VaultNotFoundError,
  SymlinkEscapeError,
  PathIsDirectoryError,
} from "../domain/errors/index.js";

let vaultDir: string;
let adapter: LocalFileSystemAdapter;

beforeEach(async () => {
  vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-test-"));
  adapter = await LocalFileSystemAdapter.create(vaultDir);
});

afterEach(async () => {
  await fs.rm(vaultDir, { recursive: true, force: true });
});

// ── Factory ────────────────────────────────────────────────────────

describe("LocalFileSystemAdapter.create", () => {
  it("throws VaultNotFoundError if vault directory does not exist", async () => {
    await expect(
      LocalFileSystemAdapter.create("/tmp/nonexistent-vault-abc123"),
    ).rejects.toThrow(VaultNotFoundError);
  });

  it("throws VaultNotFoundError if path points to a file, not directory", async () => {
    const filePath = path.join(vaultDir, "not-a-dir.txt");
    await fs.writeFile(filePath, "hello");
    await expect(LocalFileSystemAdapter.create(filePath)).rejects.toThrow(
      VaultNotFoundError,
    );
  });
});

// ── writeNote ──────────────────────────────────────────────────────

describe("writeNote", () => {
  it("creates a new note", async () => {
    await adapter.writeNote("hello.md", "# Hello\n");
    const content = await fs.readFile(path.join(vaultDir, "hello.md"), "utf-8");
    expect(content).toBe("# Hello\n");
  });

  it("creates parent directories automatically", async () => {
    await adapter.writeNote("daily/2024/01/01.md", "journal entry");
    const content = await fs.readFile(
      path.join(vaultDir, "daily/2024/01/01.md"),
      "utf-8",
    );
    expect(content).toBe("journal entry");
  });

  it("overwrites existing note when overwrite=true", async () => {
    await adapter.writeNote("note.md", "v1");
    await adapter.writeNote("note.md", "v2", true);
    const content = await fs.readFile(path.join(vaultDir, "note.md"), "utf-8");
    expect(content).toBe("v2");
  });

  it("throws NoteAlreadyExistsError when overwrite=false (default)", async () => {
    await adapter.writeNote("note.md", "v1");
    await expect(adapter.writeNote("note.md", "v2")).rejects.toThrow(
      NoteAlreadyExistsError,
    );
  });

  it("writes atomically (temp file + rename)", async () => {
    // Write a note and verify no leftover temp files
    await adapter.writeNote("atomic.md", "content");
    const files = await fs.readdir(vaultDir);
    expect(files).toEqual(["atomic.md"]);
  });

  it("rejects path traversal", async () => {
    await expect(
      adapter.writeNote("../escape.md", "bad"),
    ).rejects.toThrow(PathTraversalError);
  });
});

// ── readNote ───────────────────────────────────────────────────────

describe("readNote", () => {
  it("reads an existing note", async () => {
    await fs.writeFile(path.join(vaultDir, "existing.md"), "hello world");
    const content = await adapter.readNote("existing.md");
    expect(content).toBe("hello world");
  });

  it("throws NoteNotFoundError for missing note", async () => {
    await expect(adapter.readNote("nope.md")).rejects.toThrow(
      NoteNotFoundError,
    );
  });

  it("throws PathIsDirectoryError when path points to a directory", async () => {
    await fs.mkdir(path.join(vaultDir, "subdir"), { recursive: true });
    await fs.writeFile(path.join(vaultDir, "subdir/note.md"), "# Nested\n");
    await expect(adapter.readNote("subdir")).rejects.toThrow(
      PathIsDirectoryError,
    );
    // A real file inside the directory still reads fine.
    const content = await adapter.readNote("subdir/note.md");
    expect(content).toContain("Nested");
  });

  it("rejects path traversal", async () => {
    await expect(adapter.readNote("../../etc/passwd")).rejects.toThrow(
      PathTraversalError,
    );
  });
});

// ── deleteNote ─────────────────────────────────────────────────────

describe("deleteNote", () => {
  it("deletes an existing note", async () => {
    await fs.writeFile(path.join(vaultDir, "doomed.md"), "bye");
    await adapter.deleteNote("doomed.md");
    await expect(
      fs.access(path.join(vaultDir, "doomed.md")),
    ).rejects.toThrow();
  });

  it("throws NoteNotFoundError for missing note", async () => {
    await expect(adapter.deleteNote("nope.md")).rejects.toThrow(
      NoteNotFoundError,
    );
  });

  it("rejects path traversal", async () => {
    await expect(adapter.deleteNote("../../../tmp/x.md")).rejects.toThrow(
      PathTraversalError,
    );
  });
});

// ── exists ─────────────────────────────────────────────────────────

describe("exists", () => {
  it("returns true for existing note", async () => {
    await fs.writeFile(path.join(vaultDir, "yes.md"), "");
    expect(await adapter.exists("yes.md")).toBe(true);
  });

  it("returns false for missing note", async () => {
    expect(await adapter.exists("no.md")).toBe(false);
  });
});

// ── stat ───────────────────────────────────────────────────────────

describe("stat", () => {
  it("returns size and modified time", async () => {
    const content = "hello world"; // 11 bytes
    await fs.writeFile(path.join(vaultDir, "info.md"), content);
    const stat = await adapter.stat("info.md");
    expect(stat.sizeBytes).toBe(11);
    expect(new Date(stat.modifiedAt).getTime()).toBeGreaterThan(0);
  });

  it("throws NoteNotFoundError for missing note", async () => {
    await expect(adapter.stat("nope.md")).rejects.toThrow(NoteNotFoundError);
  });
});

// ── listNotes ──────────────────────────────────────────────────────

describe("listNotes", () => {
  it("lists all .md files recursively", async () => {
    await fs.mkdir(path.join(vaultDir, "sub"), { recursive: true });
    await fs.writeFile(path.join(vaultDir, "root.md"), "");
    await fs.writeFile(path.join(vaultDir, "sub/nested.md"), "");
    await fs.writeFile(path.join(vaultDir, "ignored.txt"), "");

    const notes = await adapter.listNotes();
    expect(notes).toEqual(["root.md", "sub/nested.md"]);
  });

  it("lists only within a subdirectory", async () => {
    await fs.mkdir(path.join(vaultDir, "daily"), { recursive: true });
    await fs.writeFile(path.join(vaultDir, "root.md"), "");
    await fs.writeFile(path.join(vaultDir, "daily/jan.md"), "");

    const notes = await adapter.listNotes("daily");
    expect(notes).toEqual(["daily/jan.md"]);
  });

  it("returns empty array for empty vault", async () => {
    const notes = await adapter.listNotes();
    expect(notes).toEqual([]);
  });

  it("returns empty array for missing subdirectory", async () => {
    const notes = await adapter.listNotes("nonexistent");
    expect(notes).toEqual([]);
  });

  it("rejects path traversal in directory argument", async () => {
    await expect(adapter.listNotes("../..")).rejects.toThrow(
      PathTraversalError,
    );
  });
});

// ── listNotes: service-directory ignore (P0-3) ────────────────────

describe("listNotes — service directories are excluded", () => {
  async function seedServiceDirs(): Promise<void> {
    for (const dir of [".stversions/Встречи", ".trash", ".obsidian/templates", "node_modules/pkg"]) {
      await fs.mkdir(path.join(vaultDir, dir), { recursive: true });
    }
    await fs.writeFile(path.join(vaultDir, "real.md"), "# Real\n");
    await fs.writeFile(path.join(vaultDir, ".stversions/Встречи/2026-09-15~20260915-143824.md"), "old\n");
    await fs.writeFile(path.join(vaultDir, ".trash/deleted.md"), "gone\n");
    await fs.writeFile(path.join(vaultDir, ".obsidian/templates/t.md"), "tpl\n");
    await fs.writeFile(path.join(vaultDir, "node_modules/pkg/readme.md"), "pkg\n");
    await fs.writeFile(path.join(vaultDir, ".hidden.md"), "hidden\n");
  }

  it("skips dot-directories, node_modules and dot-files", async () => {
    await seedServiceDirs();

    expect(await adapter.listNotes()).toEqual(["real.md"]);
  });

  it("skips them even when the requested directory is a service directory", async () => {
    await seedServiceDirs();

    expect(await adapter.listNotes(".stversions/Встречи")).toEqual([]);
  });

  it("includeHidden surfaces them again", async () => {
    await seedServiceDirs();

    const all = await adapter.listNotes(undefined, { includeHidden: true });
    expect(all).toContain("real.md");
    expect(all).toContain(".trash/deleted.md");
    expect(all).toContain("node_modules/pkg/readme.md");
    expect(all).toContain(".hidden.md");
  });

  it("honours extra ignore patterns from VAULT_IGNORE/.vaultignore", async () => {
    await fs.mkdir(path.join(vaultDir, "Archive"), { recursive: true });
    await fs.writeFile(path.join(vaultDir, "Archive/old.md"), "old\n");
    await fs.writeFile(path.join(vaultDir, "keep.md"), "keep\n");
    const scoped = await LocalFileSystemAdapter.create(vaultDir, {
      ignorePatterns: ["Archive/**"],
    });

    expect(await scoped.listNotes()).toEqual(["keep.md"]);
  });
});

// ── deleteNote: pruneEmptyDirs (P2-10) ────────────────────────────

describe("deleteNote — pruneEmptyDirs", () => {
  it("leaves the empty parent directory by default", async () => {
    await fs.mkdir(path.join(vaultDir, "_scratch-nodir"), { recursive: true });
    await fs.writeFile(path.join(vaultDir, "_scratch-nodir/note.md"), "x\n");

    await adapter.deleteNote("_scratch-nodir/note.md");

    await expect(fs.stat(path.join(vaultDir, "_scratch-nodir"))).resolves.toBeDefined();
  });

  it("removes the emptied parent directory when asked", async () => {
    await fs.mkdir(path.join(vaultDir, "_scratch-nodir"), { recursive: true });
    await fs.writeFile(path.join(vaultDir, "_scratch-nodir/note.md"), "x\n");

    await adapter.deleteNote("_scratch-nodir/note.md", { pruneEmptyDirs: true });

    await expect(fs.stat(path.join(vaultDir, "_scratch-nodir"))).rejects.toThrow();
  });

  it("never removes the vault root", async () => {
    await fs.writeFile(path.join(vaultDir, "root-note.md"), "x\n");

    await adapter.deleteNote("root-note.md", { pruneEmptyDirs: true });

    await expect(fs.stat(vaultDir)).resolves.toBeDefined();
  });

  it("keeps parents that still hold other files", async () => {
    await fs.mkdir(path.join(vaultDir, "dir"), { recursive: true });
    await fs.writeFile(path.join(vaultDir, "dir/a.md"), "a\n");
    await fs.writeFile(path.join(vaultDir, "dir/b.md"), "b\n");

    await adapter.deleteNote("dir/a.md", { pruneEmptyDirs: true });

    await expect(fs.stat(path.join(vaultDir, "dir"))).resolves.toBeDefined();
  });
});

describe("LocalFileSystemAdapter — symlink containment", () => {
  let vaultDir: string;
  let outsideDir: string;
  let adapter: LocalFileSystemAdapter;

  beforeEach(async () => {
    vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-symlink-"));
    outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "outside-"));
    adapter = await LocalFileSystemAdapter.create(vaultDir);
  });

  afterEach(async () => {
    await fs.rm(vaultDir, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  });

  it("rejects read through symlink escaping vault", async () => {
    const outsideFile = path.join(outsideDir, "secret.md");
    await fs.writeFile(outsideFile, "secret content");
    await fs.symlink(outsideFile, path.join(vaultDir, "escape.md"));

    await expect(adapter.readNote("escape")).rejects.toThrow(SymlinkEscapeError);
  });

  it("rejects write to symlink target outside vault", async () => {
    const outsideFile = path.join(outsideDir, "target.md");
    await fs.writeFile(outsideFile, "original");
    await fs.symlink(outsideFile, path.join(vaultDir, "escape.md"));

    await expect(adapter.writeNote("escape", "new content", true)).rejects.toThrow(SymlinkEscapeError);
  });

  it("rejects delete of symlink pointing outside vault", async () => {
    const outsideFile = path.join(outsideDir, "target.md");
    await fs.writeFile(outsideFile, "content");
    await fs.symlink(outsideFile, path.join(vaultDir, "escape.md"));

    await expect(adapter.deleteNote("escape")).rejects.toThrow(SymlinkEscapeError);
  });

  it("allows read through symlink pointing inside vault", async () => {
    await fs.writeFile(path.join(vaultDir, "real.md"), "# Real\n\nContent.\n");
    await fs.symlink(path.join(vaultDir, "real.md"), path.join(vaultDir, "link.md"));

    const content = await adapter.readNote("link");
    expect(content).toContain("Real");
  });

  it("rejects write under symlinked directory pointing outside vault", async () => {
    await fs.symlink(outsideDir, path.join(vaultDir, "linked-dir"));

    await expect(adapter.writeNote("linked-dir/new-file", "content")).rejects.toThrow(SymlinkEscapeError);
  });

  it("handles vault root that is itself a symlink", async () => {
    const realVault = await fs.mkdtemp(path.join(os.tmpdir(), "real-vault-"));
    const symlinkVault = path.join(os.tmpdir(), `symlink-vault-${Date.now()}`);
    await fs.symlink(realVault, symlinkVault);

    try {
      const symlinkAdapter = await LocalFileSystemAdapter.create(symlinkVault);
      await fs.writeFile(path.join(realVault, "note.md"), "# Note\n\nContent.\n");
      const content = await symlinkAdapter.readNote("note");
      expect(content).toContain("Note");
    } finally {
      await fs.unlink(symlinkVault);
      await fs.rm(realVault, { recursive: true, force: true });
    }
  });
});
