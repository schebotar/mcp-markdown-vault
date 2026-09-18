/**
 * Directory tree summaries.
 *
 * `view.outline(directory=…)` and `vault list(mode="tree")` used to either
 * dump every file (burning the agent's context) or fail outright with
 * `OUTLINE_LIMIT_EXCEEDED`. Both now default to a compact tree of
 * subdirectories with file counts, mirroring `vault overview`.
 */

/** One directory in a summary tree. */
export interface DirectoryNode {
  /** Path relative to the requested root (the root itself is ""). */
  path: string;
  /** Last path segment ("" for the root). */
  name: string;
  /** Number of `.md` files directly inside this directory. */
  fileCount: number;
  /** Number of `.md` files in this directory and all descendants. */
  totalFiles: number;
  /** Number of descendant directories. */
  totalDirectories: number;
  children: DirectoryNode[];
}

/** Result of {@link buildDirectoryTree}. */
export interface DirectoryTreeResult {
  /** The synthetic root node. */
  root: DirectoryNode;
  /** True when deeper directories were collapsed by `maxDepth`. */
  truncated: boolean;
}

interface MutableNode extends DirectoryNode {
  childIndex: Map<string, MutableNode>;
}

function makeNode(relPath: string): MutableNode {
  const segments = relPath.length > 0 ? relPath.split("/") : [];
  return {
    path: relPath,
    name: segments.length > 0 ? segments[segments.length - 1]! : "",
    fileCount: 0,
    totalFiles: 0,
    totalDirectories: 0,
    children: [],
    childIndex: new Map(),
  };
}

function finalize(node: MutableNode): DirectoryNode {
  const children: DirectoryNode[] = [];
  for (const child of node.childIndex.values()) {
    const finalized = finalize(child);
    children.push(finalized);
    node.totalFiles += finalized.totalFiles;
    node.totalDirectories += 1 + finalized.totalDirectories;
  }
  children.sort((a, b) => a.name.localeCompare(b.name));
  node.children = children;
  node.totalFiles += node.fileCount;
  // Drop the internal index before handing the node to callers.
  delete (node as Partial<MutableNode>).childIndex;
  return node;
}

/**
 * Build a directory tree from vault-relative file paths.
 *
 * @param relPaths Vault-relative `.md` paths, all under `root`.
 * @param root Directory the tree is rooted at ("" for the vault root).
 * @param maxDepth Maximum directory depth to expand (default 3). Deeper
 *   directories are folded into their ancestor's counts and reported via
 *   `truncated`.
 */
export function buildDirectoryTree(
  relPaths: readonly string[],
  root: string,
  maxDepth = 3,
): DirectoryTreeResult {
  const prefix = root.length > 0 ? `${root.replace(/\/+$/, "")}/` : "";
  const rootNode = makeNode("");
  let truncated = false;

  for (const relPath of relPaths) {
    if (prefix.length > 0 && !relPath.startsWith(prefix)) continue;
    const local = prefix.length > 0 ? relPath.slice(prefix.length) : relPath;
    const segments = local.split("/");
    if (segments.length === 0) continue;

    // The last segment is the file itself.
    const dirSegments = segments.slice(0, -1);
    if (dirSegments.length > maxDepth) truncated = true;

    let current = rootNode;
    const walk = Math.min(dirSegments.length, maxDepth);
    for (let i = 0; i < walk; i++) {
      const dirPath = dirSegments.slice(0, i + 1).join("/");
      let child = current.childIndex.get(dirSegments[i]!);
      if (child === undefined) {
        child = makeNode(dirPath);
        current.childIndex.set(dirSegments[i]!, child);
      }
      current = child;
    }
    current.fileCount++;
    if (dirSegments.length > maxDepth) {
      // Counts for the collapsed tail still land on the deepest kept node.
      truncated = true;
    }
  }

  finalize(rootNode);
  return { root: rootNode, truncated };
}
