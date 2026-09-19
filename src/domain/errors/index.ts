import {
  describePortabilityViolations,
  type PortabilityViolation,
} from "../value-objects/portable-path.js";

/**
 * Base class for all domain errors.
 * Carries a machine-readable `code` for programmatic handling
 * and a human-readable `message` for logging/debugging.
 */
export class DomainError extends Error {
  public readonly code: string;

  /** Optional actionable next step, surfaced in the tool error response. */
  public readonly hint: string | undefined;

  constructor(code: string, message: string, cause?: Error, hint?: string) {
    super(message, { cause });
    this.code = code;
    this.hint = hint;
    this.name = "DomainError";
  }
}

// ── File-system / Vault errors ──────────────────────────────────────

export class VaultNotFoundError extends DomainError {
  constructor(vaultPath: string) {
    super("VAULT_NOT_FOUND", `Vault not found at path: ${vaultPath}`);
    this.name = "VaultNotFoundError";
  }
}

export class PathTraversalError extends DomainError {
  constructor(path: string) {
    super("PATH_TRAVERSAL", `Path traversal detected: ${path}`);
    this.name = "PathTraversalError";
  }
}

export class NoteNotFoundError extends DomainError {
  constructor(notePath: string, hint?: string) {
    super("NOTE_NOT_FOUND", `Note not found: ${notePath}`, undefined, hint);
    this.name = "NoteNotFoundError";
  }
}

export class NoteAlreadyExistsError extends DomainError {
  constructor(notePath: string) {
    super("NOTE_ALREADY_EXISTS", `Note already exists: ${notePath}`);
    this.name = "NoteAlreadyExistsError";
  }
}

export class InvalidNotePathError extends DomainError {
  constructor(notePath: string) {
    super("INVALID_NOTE_PATH", `Invalid note path: ${notePath}`);
    this.name = "InvalidNotePathError";
  }
}

/** Thrown when a vault-relative path points to a directory instead of a note file. */
export class PathIsDirectoryError extends DomainError {
  constructor(path: string, hint?: string) {
    super(
      "PATH_IS_DIRECTORY",
      `Path is a directory, not a note: ${path}${hint ? ` — ${hint}` : ""}`,
      undefined,
      hint,
    );
    this.name = "PathIsDirectoryError";
  }
}

// ── AST / Parsing errors ───────────────────────────────────────────

export class AstPatchError extends DomainError {
  constructor(detail: string, cause?: Error) {
    super("AST_PATCH_FAILED", `AST patch failed: ${detail}`, cause);
    this.name = "AstPatchError";
  }
}

/** A heading that exists in the document, reported when a target misses. */
export interface HeadingCandidate {
  title: string;
  depth: number;
  index: number;
}

function describeCandidates(
  candidates: ReadonlyArray<HeadingCandidate>,
): string {
  return candidates
    .map((c) => `"${c.title}" (headingDepth: ${c.depth})`)
    .join(", ");
}

export class HeadingNotFoundError extends DomainError {
  /** Fuzzy suggestions, formatted as `"Title" (headingDepth: N)`. */
  public readonly suggestions: readonly string[];

  /** Existing headings that matched the title at a different depth. */
  public readonly candidates: ReadonlyArray<HeadingCandidate>;

  constructor(
    title: string,
    depth: number,
    options?: {
      suggestions?: readonly string[] | undefined;
      candidates?: ReadonlyArray<HeadingCandidate> | undefined;
    },
  ) {
    const suggestions = options?.suggestions ?? [];
    const candidates = options?.candidates ?? [];

    let message = `Heading not found: "${title}" at depth ${depth}`;
    if (candidates.length > 0) {
      message += `. The heading exists at another depth: ${describeCandidates(candidates)}`;
    } else if (suggestions.length > 0) {
      message += `. Did you mean: ${suggestions.map((s) => JSON.stringify(s)).join(", ")}?`;
    }

    super(
      "HEADING_NOT_FOUND",
      message,
      undefined,
      "Run view.outline (or view.outline with directory) to list available headings with their depth, then pass headingDepth explicitly.",
    );
    this.name = "HeadingNotFoundError";
    this.suggestions = suggestions;
    this.candidates = candidates;
  }
}

export class BlockNotFoundError extends DomainError {
  constructor(blockId: string) {
    super("BLOCK_NOT_FOUND", `Block not found: ${blockId}`);
    this.name = "BlockNotFoundError";
  }
}

// ── Freeform editing errors ───────────────────────────────────────

export class FreeformEditError extends DomainError {
  constructor(detail: string) {
    super("FREEFORM_EDIT_FAILED", `Freeform edit failed: ${detail}`);
    this.name = "FreeformEditError";
  }
}

// ── Embedding / Vector errors ──────────────────────────────────────

export class EmbeddingError extends DomainError {
  constructor(detail: string, cause?: Error) {
    super("EMBEDDING_FAILED", `Embedding failed: ${detail}`, cause);
    this.name = "EmbeddingError";
  }
}

export class VectorDbError extends DomainError {
  constructor(detail: string, cause?: Error) {
    super("VECTOR_DB_ERROR", `Vector DB error: ${detail}`, cause);
    this.name = "VectorDbError";
  }
}

// ── Frontmatter errors ────────────────────────────────────────────

export class InvalidFrontmatterPayloadError extends DomainError {
  constructor(detail: string) {
    super(
      "INVALID_FRONTMATTER_PAYLOAD",
      `Invalid frontmatter payload: ${detail}`,
      undefined,
      'Pass frontmatter as a JSON object, e.g. edit { operation: "frontmatter_set", frontmatter: { "status": "draft" } }. ' +
        'Legacy form: content: \'{"status":"draft"}\' (a JSON object string, not YAML).',
    );
    this.name = "InvalidFrontmatterPayloadError";
  }
}

/** Thrown when existing YAML frontmatter in a note cannot be parsed. */
export class InvalidFrontmatterYamlError extends DomainError {
  constructor(filePath: string, cause?: unknown) {
    super(
      "INVALID_FRONTMATTER_YAML",
      `Invalid YAML in frontmatter of ${filePath}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      cause instanceof Error ? cause : undefined,
    );
    this.name = "InvalidFrontmatterYamlError";
  }
}

// ── Batch errors ─────────────────────────────────────────────────

export class BatchLimitExceededError extends DomainError {
  constructor(count: number, limit: number) {
    super(
      "BATCH_LIMIT_EXCEEDED",
      `Batch limit exceeded: ${count} operations requested, max ${limit} allowed`,
    );
    this.name = "BatchLimitExceededError";
  }
}

// ── Authentication errors ─────────────────────────────────────────

export class AuthenticationError extends DomainError {
  constructor(detail: string) {
    super("AUTHENTICATION_FAILED", `Authentication failed: ${detail}`);
    this.name = "AuthenticationError";
  }
}

// ── Workflow / State errors ────────────────────────────────────────

export class StateTransitionError extends DomainError {
  constructor(from: string, to: string) {
    super(
      "INVALID_STATE_TRANSITION",
      `Invalid state transition from "${from}" to "${to}"`,
    );
    this.name = "StateTransitionError";
  }
}

// ── Security errors ───────────────────────────────────────────────

export class AbsolutePathError extends DomainError {
  constructor(path: string) {
    super("ABSOLUTE_PATH_REJECTED", `Absolute path rejected: ${path}`);
    this.name = "AbsolutePathError";
  }
}

export class SymlinkEscapeError extends DomainError {
  constructor(resolvedPath: string) {
    super(
      "SYMLINK_ESCAPE_DETECTED",
      `Symlink escapes vault boundary: ${resolvedPath}`,
    );
    this.name = "SymlinkEscapeError";
  }
}

/**
 * Thrown when creating a note would produce a name that cannot exist on
 * Windows (and therefore cannot be synced to a Windows machine).
 *
 * Only creation is guarded — an already existing note with such a name stays
 * readable and editable so it can be renamed or fixed.
 */
export class NonPortablePathError extends DomainError {
  /** Every rule violation found, so the caller can report all of them at once. */
  public readonly violations: ReadonlyArray<PortabilityViolation>;

  constructor(notePath: string, violations: ReadonlyArray<PortabilityViolation>) {
    const lines = describePortabilityViolations(violations);
    super(
      "NON_PORTABLE_PATH",
      `Path is not portable to Windows: ${notePath}\n${lines.map((l) => `  - ${l}`).join("\n")}`,
      undefined,
      "Rename the note/directory (drop the reserved characters, trailing dots/spaces and " +
        "device names CON/PRN/AUX/NUL/COM1-9/LPT1-9), or set VAULT_PATH_POLICY=off to " +
        "disable the check. Read-only actions and updates of existing notes are never blocked.",
    );
    this.name = "NonPortablePathError";
    this.violations = violations;
  }
}

// ── Argument errors ───────────────────────────────────────────────

export class InvalidArgumentError extends DomainError {
  constructor(argumentName: string, hint?: string) {
    super(
      "INVALID_ARGUMENT",
      `Required argument missing: ${argumentName}`,
      undefined,
      hint,
    );
    this.name = "InvalidArgumentError";
  }
}

// ── Config errors ─────────────────────────────────────────────────

export class InvalidConfigError extends DomainError {
  constructor(detail: string) {
    super("INVALID_CONFIG", `Invalid configuration: ${detail}`);
    this.name = "InvalidConfigError";
  }
}

// ── Edit UX / Heading-operation errors ───────────────────────────

/** Thrown when a heading target is ambiguous due to duplicate headings. */
export class AmbiguousHeadingTargetError extends DomainError {
  public readonly candidates: ReadonlyArray<HeadingCandidate>;

  /** Fuzzy suggestions, formatted as `"Title" (headingDepth: N)`. */
  public readonly suggestions: readonly string[];

  constructor(
    title: string,
    depth: number,
    candidates: ReadonlyArray<HeadingCandidate>,
    suggestions: readonly string[] = [],
  ) {
    super(
      "AMBIGUOUS_HEADING_TARGET",
      `Ambiguous heading target: "${title}" matched ${candidates.length} headings ` +
        `(requested depth ${depth}): ${describeCandidates(candidates)}. ` +
        `Use blockId targeting to disambiguate. ` +
        `Add block IDs like "^my-id" to the relevant heading sections first, ` +
        `then reference via blockId instead of heading text.`,
    );
    this.name = "AmbiguousHeadingTargetError";
    this.candidates = candidates;
    this.suggestions = suggestions;
  }
}

/** Thrown when a delete target is structurally unsafe (e.g., would remove the entire document). */
export class UnsafeDeleteTargetError extends DomainError {
  constructor(detail: string) {
    super("UNSAFE_DELETE_TARGET", `Unsafe delete target: ${detail}`);
    this.name = "UnsafeDeleteTargetError";
  }
}

/** Thrown when directory outline exceeds configured file or heading limits. */
export class OutlineLimitExceededError extends DomainError {
  constructor(detail: string) {
    super("OUTLINE_LIMIT_EXCEEDED", `Outline limit exceeded: ${detail}`);
    this.name = "OutlineLimitExceededError";
  }
}
