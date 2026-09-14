import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { LocalFileSystemAdapter } from "../infrastructure/local-fs-adapter.js";
import { NoteNotFoundError } from "../domain/errors/index.js";
import { fingerprintNote, sha256Short } from "./file-fingerprint.js";

let vaultDir: string;
let adapter: LocalFileSystemAdapter;

beforeEach(async () => {
  vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "fingerprint-test-"));
  adapter = await LocalFileSystemAdapter.create(vaultDir);
});

afterEach(async () => {
  await fs.rm(vaultDir, { recursive: true, force: true });
});

describe("fingerprintNote", () => {
  it("returns size, mtime and a 12-char sha256", async () => {
    await fs.writeFile(path.join(vaultDir, "f.md"), "hello world");

    const fp = await fingerprintNote(adapter, "f.md");

    expect(fp.sizeBytes).toBe(11);
    expect(new Date(fp.mtime).getTime()).toBeGreaterThan(0);
    expect(fp.sha256).toMatch(/^[0-9a-f]{12}$/);
    expect(fp.sha256).toBe(sha256Short("hello world"));
  });

  it("uses provided content instead of re-reading the file", async () => {
    await fs.writeFile(path.join(vaultDir, "f.md"), "actual file content");

    const fp = await fingerprintNote(adapter, "f.md", "provided");

    expect(fp.sha256).toBe(sha256Short("provided"));
    expect(fp.sizeBytes).toBe(8);
  });

  it("throws NoteNotFoundError for a missing note", async () => {
    await expect(fingerprintNote(adapter, "nope.md")).rejects.toThrow(
      NoteNotFoundError,
    );
  });
});

describe("sha256Short", () => {
  it("is stable and 12 hex chars", () => {
    expect(sha256Short("abc")).toBe(sha256Short("abc"));
    expect(sha256Short("abc")).toMatch(/^[0-9a-f]{12}$/);
    expect(sha256Short("abc")).not.toBe(sha256Short("abd"));
  });
});
