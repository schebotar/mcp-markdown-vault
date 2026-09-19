import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type {
  DeleteNoteOptions,
  IFileSystemAdapter,
  ListNotesOptions,
  NoteStat,
} from "../domain/interfaces/index.js";
import {
  VaultNotFoundError,
  NoteNotFoundError,
  NoteAlreadyExistsError,
  SymlinkEscapeError,
  PathIsDirectoryError,
  NonPortablePathError,
} from "../domain/errors/index.js";
import { SafePath } from "../domain/value-objects/index.js";
import {
  DEFAULT_PORTABLE_PATH_CHARSET,
  DEFAULT_PORTABLE_PATH_POLICY,
  findSegmentViolations,
} from "../domain/value-objects/index.js";
import type {
  PortabilityViolation,
  PortablePathCharset,
  PortablePathPolicy,
} from "../domain/value-objects/index.js";
import { isIgnoredPath } from "../use-cases/vault-ignore.js";

/** Construction options for {@link LocalFileSystemAdapter}. */
export interface LocalFileSystemAdapterOptions {
  /**
   * Extra glob patterns whose matches are excluded from note listings
   * (from `VAULT_IGNORE` and `.vaultignore`).
   */
  ignorePatterns?: readonly string[];

  /**
   * Enforcement level for cross-platform (Windows-safe) names — see
   * `portable-path.ts`. `"error"` (default) rejects creating a note or
   * directory whose name Windows cannot store, so the vault stays syncable to
   * a Windows machine; `"warn"` only reports; `"off"` disables the check.
   *
   * Only creation is affected: reading, editing, searching and overwriting an
   * existing note is never blocked, so an already non-portable note can still
   * be opened and renamed.
   */
  portablePathPolicy?: PortablePathPolicy;

  /**
   * Name charset. `"unicode"` (default) allows Cyrillic and other non-ASCII
   * names; `"strict-ascii"` rejects them as well.
   */
  portablePathCharset?: PortablePathCharset;
}

export class LocalFileSystemAdapter implements IFileSystemAdapter {
  private readonly vaultRoot: string;
  private readonly canonicalRoot: string;
  private readonly ignorePatterns: readonly string[];
  private readonly portablePathPolicy: PortablePathPolicy;
  private readonly portablePathCharset: PortablePathCharset;

  private constructor(
    vaultRoot: string,
    canonicalRoot: string,
    ignorePatterns: readonly string[],
    portablePathPolicy: PortablePathPolicy,
    portablePathCharset: PortablePathCharset,
  ) {
    this.vaultRoot = vaultRoot;
    this.canonicalRoot = canonicalRoot;
    this.ignorePatterns = ignorePatterns;
    this.portablePathPolicy = portablePathPolicy;
    this.portablePathCharset = portablePathCharset;
  }

  static async create(
    vaultRoot: string,
    options?: LocalFileSystemAdapterOptions,
  ): Promise<LocalFileSystemAdapter> {
    const resolved = path.resolve(vaultRoot);
    try {
      const stat = await fs.stat(resolved);
      if (!stat.isDirectory()) {
        throw new VaultNotFoundError(vaultRoot);
      }
    } catch (err) {
      if (err instanceof VaultNotFoundError) throw err;
      throw new VaultNotFoundError(vaultRoot);
    }
    const canonicalRoot = await fs.realpath(resolved);
    return new LocalFileSystemAdapter(
      resolved,
      canonicalRoot,
      options?.ignorePatterns ?? [],
      options?.portablePathPolicy ?? DEFAULT_PORTABLE_PATH_POLICY,
      options?.portablePathCharset ?? DEFAULT_PORTABLE_PATH_CHARSET,
    );
  }

  private async assertContained(absPath: string): Promise<void> {
    let canonical: string;
    try {
      canonical = await fs.realpath(absPath);
    } catch {
      await this.assertParentContained(absPath);
      return;
    }
    if (!canonical.startsWith(this.canonicalRoot + path.sep) && canonical !== this.canonicalRoot) {
      throw new SymlinkEscapeError(canonical);
    }
  }

  private async assertParentContained(absPath: string): Promise<void> {
    let current = path.dirname(absPath);
    while (true) {
      try {
        const canonical = await fs.realpath(current);
        if (!canonical.startsWith(this.canonicalRoot + path.sep) && canonical !== this.canonicalRoot) {
          throw new SymlinkEscapeError(canonical);
        }
        return;
      } catch (err) {
        if (err instanceof SymlinkEscapeError) throw err;
        const parent = path.dirname(current);
        if (parent === current) return;
        current = parent;
      }
    }
  }

  async listNotes(
    directory?: string,
    options?: ListNotesOptions,
  ): Promise<string[]> {
    const target = directory
      ? SafePath.createDirectory(this.vaultRoot, directory)
      : SafePath.createDirectory(this.vaultRoot, "");

    await this.assertContained(target.absolute);

    try {
      await fs.access(target.absolute);
    } catch {
      return [];
    }

    const entries = await fs.readdir(target.absolute, {
      recursive: true,
      withFileTypes: true,
    });

    const includeHidden = options?.includeHidden ?? false;
    const mdFiles: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".md")) continue;

      // Build the vault-relative path
      // parentPath is the modern API; fall back to (entry as any).path for older Node
      const entryDir: string =
        entry.parentPath ??
        (entry as unknown as { path: string }).path;
      const fullPath = path.join(entryDir, entry.name);
      const relative = path.relative(this.vaultRoot, fullPath);

      // Service directories (.obsidian, .trash, .stversions, …) and configured
      // patterns are excluded here so every consumer agrees on the note set.
      if (isIgnoredPath(relative, this.ignorePatterns, includeHidden)) continue;

      mdFiles.push(relative);
    }

    return mdFiles.sort();
  }

  async readNote(notePath: string): Promise<string> {
    const safePath = SafePath.create(this.vaultRoot, notePath);
    await this.assertContained(safePath.absolute);

    // SafePath.create auto-appends ".md". When the caller passes a directory
    // (e.g. "daily" or "Встречи/"), that file path won't exist — detect the
    // directory so we can raise PATH_IS_DIRECTORY instead of a misleading
    // NOTE_NOT_FOUND.
    let fileStat: Awaited<ReturnType<typeof fs.stat>> | undefined;
    try {
      fileStat = await fs.stat(safePath.absolute);
    } catch {
      // File missing — checked below.
    }

    if (fileStat !== undefined) {
      if (fileStat.isDirectory()) {
        throw new PathIsDirectoryError(notePath);
      }
      return await fs.readFile(safePath.absolute, "utf-8");
    }

    // File does not exist — check whether the raw path names an existing
    // directory (e.g. "subdir" or "subdir/").
    const rawDir = notePath.replace(/[/\\]+$/, "");
    if (rawDir.length > 0 && !rawDir.endsWith(".md")) {
      const dirSafe = SafePath.createDirectory(this.vaultRoot, rawDir);
      try {
        const dirStat = await fs.stat(dirSafe.absolute);
        if (dirStat.isDirectory()) {
          throw new PathIsDirectoryError(notePath);
        }
      } catch (err) {
        if (err instanceof PathIsDirectoryError) throw err;
        // Not an existing directory — fall through to NOTE_NOT_FOUND.
      }
    }

    throw new NoteNotFoundError(notePath);
  }

  async writeNote(
    notePath: string,
    content: string,
    overwrite?: boolean,
  ): Promise<void> {
    const safePath = SafePath.create(this.vaultRoot, notePath);
    await this.assertContained(safePath.absolute);

    // Portability guard — creation only. An existing note is never blocked:
    // a name that is already non-portable must stay readable/editable (and
    // overwritable) so it can be fixed or renamed.
    let fileExists = true;
    try {
      await fs.access(safePath.absolute);
    } catch {
      fileExists = false;
    }

    if (!fileExists && this.portablePathPolicy !== "off") {
      await this.assertCreationNamesPortable(notePath, safePath.absolute);
    }

    // Check for existing file when overwrite is not enabled
    if (!overwrite && fileExists) {
      throw new NoteAlreadyExistsError(notePath);
    }

    // Ensure parent directory exists
    const dir = path.dirname(safePath.absolute);
    await fs.mkdir(dir, { recursive: true });

    // Atomic write: write to temp file then rename
    const tmpName = `.${crypto.randomUUID()}.tmp`;
    const tmpPath = path.join(dir, tmpName);

    try {
      await fs.writeFile(tmpPath, content, "utf-8");
      await fs.rename(tmpPath, safePath.absolute);
    } catch (err) {
      // Clean up temp file on failure
      try {
        await fs.unlink(tmpPath);
      } catch {
        // Ignore cleanup errors
      }
      throw err;
    }
  }

  /**
   * Validate every name this write is about to create: the note file name plus
   * the directory segments that do not exist yet.
   *
   * Two exemptions, both deliberate:
   *
   * - Segments that ALREADY exist on disk are skipped. A folder like
   *   `legacy 12:30/` created before the guard (or by another machine) must not
   *   prevent new, perfectly portable notes from being created inside it, and
   *   an existing non-portable note must stay readable/editable — otherwise the
   *   guard would lock the user out of their own vault. Those names are
   *   reported by `vault action="audit_names"` instead.
   * - Content inside an existing service directory (`.obsidian/templates/…`,
   *   `.trash/…`) is not synced note content, so it is left alone.
   */
  private async assertCreationNamesPortable(
    notePath: string,
    absoluteFilePath: string,
  ): Promise<void> {
    const toValidate: string[] = [path.basename(absoluteFilePath)];
    let current = path.dirname(absoluteFilePath);

    while (current.startsWith(this.vaultRoot + path.sep)) {
      let isExistingDir = false;
      try {
        isExistingDir = (await fs.stat(current)).isDirectory();
      } catch {
        // Not created yet — this write will create it.
      }

      if (isExistingDir) {
        // Stop at the first existing ancestor. If it is a dot-prefixed service
        // directory, everything below it is service content and the segments
        // collected so far are fine to leave unchecked.
        if (path.basename(current).startsWith(".")) return;
        break;
      }

      toValidate.unshift(path.basename(current));
      current = path.dirname(current);
    }

    const violations = toValidate.flatMap((segment) =>
      findSegmentViolations(segment, { charset: this.portablePathCharset }),
    );
    if (violations.length > 0) {
      this.handleViolations(notePath, violations);
    }
  }

  private handleViolations(
    notePath: string,
    violations: readonly PortabilityViolation[],
  ): void {
    if (this.portablePathPolicy === "error") {
      throw new NonPortablePathError(notePath, violations);
    }
    console.error(
      `[portable-path] ${notePath} is not Windows-portable: ` +
        violations.map((v) => `${v.segment} (${v.code})`).join(", "),
    );
  }

  async deleteNote(
    notePath: string,
    options?: DeleteNoteOptions,
  ): Promise<void> {
    const safePath = SafePath.create(this.vaultRoot, notePath);
    await this.assertContained(safePath.absolute);
    try {
      await fs.unlink(safePath.absolute);
    } catch {
      throw new NoteNotFoundError(notePath);
    }
    if (options?.pruneEmptyDirs) {
      await this.pruneEmptyParents(path.dirname(safePath.absolute));
    }
  }

  /** Remove parent directories that became empty, stopping at the vault root. */
  private async pruneEmptyParents(startDir: string): Promise<void> {
    let current = startDir;
    while (
      current.startsWith(this.vaultRoot + path.sep) &&
      current !== this.vaultRoot
    ) {
      let entries: string[];
      try {
        entries = await fs.readdir(current);
      } catch {
        return;
      }
      if (entries.length > 0) return;
      try {
        await fs.rmdir(current);
      } catch {
        return;
      }
      current = path.dirname(current);
    }
  }

  async exists(notePath: string): Promise<boolean> {
    const safePath = SafePath.create(this.vaultRoot, notePath);
    await this.assertContained(safePath.absolute);
    try {
      await fs.access(safePath.absolute);
      return true;
    } catch {
      return false;
    }
  }

  async stat(notePath: string): Promise<NoteStat> {
    const safePath = SafePath.create(this.vaultRoot, notePath);
    await this.assertContained(safePath.absolute);
    try {
      const fileStat = await fs.stat(safePath.absolute);
      return {
        sizeBytes: fileStat.size,
        modifiedAt: fileStat.mtime.toISOString(),
      };
    } catch {
      throw new NoteNotFoundError(notePath);
    }
  }
}
