import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { LocalFileSystemAdapter } from "../infrastructure/local-fs-adapter.js";
import { UnifiedDiffService } from "../infrastructure/diff-service.js";
import { NormalizeLinksUseCase, normalizeWikilinks } from "./normalize-links.js";

let vaultDir: string;
let adapter: LocalFileSystemAdapter;
let useCase: NormalizeLinksUseCase;

beforeEach(async () => {
  vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "normalize-links-"));
  adapter = await LocalFileSystemAdapter.create(vaultDir);
  useCase = new NormalizeLinksUseCase(adapter, new UnifiedDiffService());
});

afterEach(async () => {
  await fs.rm(vaultDir, { recursive: true, force: true });
});

describe("normalizeWikilinks", () => {
  it("removes backslashes before [ and ] and counts them", () => {
    const result = normalizeWikilinks("\\[\\[a]] and \\_ x and \\]");
    expect(result.content).toBe("[[a]] and \\_ x and ]");
    expect(result.replacements).toBe(3);
  });

  it("leaves content without escapes unchanged", () => {
    const result = normalizeWikilinks("[[a]] plain");
    expect(result.content).toBe("[[a]] plain");
    expect(result.replacements).toBe(0);
  });
});

describe("NormalizeLinksUseCase", () => {
  it("previews by default and does not write", async () => {
    const original = "# T\n\n\\[\\[Agent/a]] and \\_x\n";
    await fs.writeFile(path.join(vaultDir, "links.md"), original);

    const result = await useCase.execute({ path: "links.md" });

    expect(result.dryRun).toBe(true);
    expect(result.replacements).toBeGreaterThan(0);
    expect(result.diff).toBeDefined();
    expect(await fs.readFile(path.join(vaultDir, "links.md"), "utf-8")).toBe(original);
  });

  it("writes canonical links when dryRun=false", async () => {
    await fs.writeFile(path.join(vaultDir, "links2.md"), "# T\n\n\\[\\[Agent/a]]\n");

    const result = await useCase.execute({ path: "links2.md", dryRun: false });

    expect(result.dryRun).toBe(false);
    const after = await fs.readFile(path.join(vaultDir, "links2.md"), "utf-8");
    expect(after).toContain("[[Agent/a]]");
    expect(after).not.toContain("\\[\\[");
  });
});
