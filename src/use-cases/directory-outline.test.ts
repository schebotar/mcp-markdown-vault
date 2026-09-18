import { describe, it, expect } from "vitest";
import { buildDirectoryTree } from "./directory-outline.js";

const PATHS = [
  "Встречи/2026-09-15.md",
  "Встречи/2026-09-16.md",
  "Встречи/Контрактный менеджмент/2026-09-07.md",
  "Встречи/Контрактный менеджмент/deep/nested.md",
  "Agent/pitfalls/README.md",
  "root.md",
];

describe("buildDirectoryTree", () => {
  it("counts direct and recursive files per directory", () => {
    const { root } = buildDirectoryTree(PATHS, "", 5);
    const dirs = new Map(root.children.map((c) => [c.name, c]));

    expect(root.fileCount).toBe(1);
    expect(root.totalFiles).toBe(PATHS.length);

    const meetings = dirs.get("Встречи")!;
    expect(meetings.fileCount).toBe(2);
    expect(meetings.totalFiles).toBe(4);

    const contract = meetings.children.find((c) => c.name === "Контрактный менеджмент")!;
    expect(contract.fileCount).toBe(1);
    expect(contract.totalFiles).toBe(2);
    expect(contract.totalDirectories).toBe(1);
  });

  it("sorts children by name", () => {
    const { root } = buildDirectoryTree(PATHS, "", 5);
    expect(root.children.map((c) => c.name)).toEqual(["Agent", "Встречи"]);
  });

  it("roots the tree at a directory prefix", () => {
    const { root } = buildDirectoryTree(PATHS, "Встречи", 5);
    expect(root.totalFiles).toBe(4);
    expect(root.fileCount).toBe(2);
    expect(root.children.map((c) => c.name)).toEqual(["Контрактный менеджмент"]);
  });

  it("collapses deeper directories at maxDepth and reports truncated", () => {
    const { root, truncated } = buildDirectoryTree(PATHS, "", 1);
    expect(truncated).toBe(true);
    const meetings = root.children.find((c) => c.name === "Встречи")!;
    expect(meetings.children).toHaveLength(0);
    // Collapsed descendants still contribute to the kept ancestor's counts.
    expect(meetings.totalFiles).toBe(4);
  });

  it("is not truncated when everything fits", () => {
    const { truncated } = buildDirectoryTree(PATHS, "", 5);
    expect(truncated).toBe(false);
  });

  it("handles an empty vault", () => {
    const { root, truncated } = buildDirectoryTree([], "", 3);
    expect(root.totalFiles).toBe(0);
    expect(root.children).toEqual([]);
    expect(truncated).toBe(false);
  });
});
