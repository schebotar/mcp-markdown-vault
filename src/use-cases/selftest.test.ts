import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { LocalFileSystemAdapter } from "../infrastructure/local-fs-adapter.js";
import { SelftestUseCase } from "./selftest.js";

let vaultDir: string;
let adapter: LocalFileSystemAdapter;

beforeEach(async () => {
  vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "selftest-"));
  adapter = await LocalFileSystemAdapter.create(vaultDir);
});

afterEach(async () => {
  await fs.rm(vaultDir, { recursive: true, force: true });
});

describe("SelftestUseCase", () => {
  it("passes the round-trip and removes the temporary file", async () => {
    const result = await new SelftestUseCase(adapter).execute();

    expect(result.status).toBe("PASS");
    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.steps.every((step) => step.ok)).toBe(true);
    expect(await adapter.listNotes()).toEqual([]);
  });
});
