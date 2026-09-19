/**
 * Cross-platform (Windows ⇄ Linux ⇄ macOS) file-name portability rules.
 *
 * A vault is usually synced (Syncthing, Nextcloud, Dropbox, git, …) to a
 * Windows machine. Windows refuses names that Linux accepts happily, so a note
 * created as `Встреча 12:30.md` on Linux silently fails to sync — and the user
 * discovers it only when the file is half-copied or listed as a sync conflict.
 *
 * The rules live here (domain layer, no I/O) and are enforced by
 * {@link LocalFileSystemAdapter} on **creation** only: reading, editing,
 * searching and renaming an existing note must keep working even if its name is
 * already non-portable, otherwise the offending file could never be fixed.
 *
 * Windows rejects a name when it:
 * - contains one of `< > : " / \ | ? *`
 * - contains a control character (0x00–0x1F, 0x7F)
 * - ends with a dot or a space (the character is silently dropped, so the file
 *   lands under a different name and the sync engine reports a conflict)
 * - is a reserved device name: `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`,
 *   `LPT1`–`LPT9` (also with any extension, e.g. `aux.md`)
 * - is longer than 255 characters
 *
 * Non-ASCII names (Cyrillic, emoji, …) are legal on Windows and are allowed by
 * default. Set `VAULT_PATH_POLICY=strict-ascii` to require ASCII-only names as
 * well — that is the bulletproof option for cross-platform sync, since it also
 * avoids NFC/NFD normalisation mismatches and other Unicode surprises.
 */

/** Enforcement level for portable-name checks. */
export type PortablePathPolicy = "error" | "warn" | "off";

/** Policy sub-mode names accepted as a suffix, e.g. `error:strict-ascii`. */
export type PortablePathCharset = "unicode" | "strict-ascii";

/** Machine-readable reason a path cannot be shared with Windows. */
export type PortabilityViolationCode =
  | "RESERVED_CHARACTER"
  | "CONTROL_CHARACTER"
  | "TRAILING_DOT_OR_SPACE"
  | "RESERVED_DEVICE_NAME"
  | "NAME_TOO_LONG"
  | "NON_ASCII_NAME";

/** One reason a single path segment is not portable. */
export interface PortabilityViolation {
  /** Vault-relative path (as passed by the caller). */
  path: string;
  /** Offending segment (file or directory name). */
  segment: string;
  /** Zero-based index of the segment within the path. */
  segmentIndex: number;
  code: PortabilityViolationCode;
  /** Human-readable explanation, e.g. which character was rejected. */
  detail: string;
}

/** Characters Windows forbids in a file or directory name. */
const RESERVED_CHARACTERS = new Set(["<", ">", ":", '"', "/", "\\", "|", "?", "*"]);

/** Windows device names that cannot be used, even with an extension. */
const RESERVED_DEVICE_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

/** Windows component length limit (NTFS/ext4 agree on 255). */
const MAX_SEGMENT_LENGTH = 255;

/** Default policy when `VAULT_PATH_POLICY` is unset. */
export const DEFAULT_PORTABLE_PATH_POLICY: PortablePathPolicy = "error";

/** Default charset mode when `VAULT_PATH_POLICY` is unset. */
export const DEFAULT_PORTABLE_PATH_CHARSET: PortablePathCharset = "unicode";

/**
 * Parse `VAULT_PATH_POLICY`.
 *
 * Accepted values:
 * - `off` — no checks at all
 * - `error` (default) — reject creation of non-portable names
 * - `warn` — allow creation, but report the violations to the caller
 * - any of the above with a `:strict-ascii` suffix (`error:strict-ascii`),
 *   which additionally rejects non-ASCII names
 * - the bare `strict-ascii`, shorthand for `error:strict-ascii`
 */
export function parsePortablePathPolicy(value: string | undefined): {
  policy: PortablePathPolicy;
  charset: PortablePathCharset;
} {
  if (value === undefined || value.trim().length === 0) {
    return {
      policy: DEFAULT_PORTABLE_PATH_POLICY,
      charset: DEFAULT_PORTABLE_PATH_CHARSET,
    };
  }

  const parts = value
    .trim()
    .toLowerCase()
    .split(":")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  let policy: PortablePathPolicy = DEFAULT_PORTABLE_PATH_POLICY;
  let charset: PortablePathCharset = DEFAULT_PORTABLE_PATH_CHARSET;
  let sawPolicy = false;

  for (const part of parts) {
    if (part === "off" || part === "error" || part === "warn") {
      policy = part;
      sawPolicy = true;
      continue;
    }
    if (part === "strict-ascii" || part === "unicode") {
      charset = part;
      continue;
    }
    // Unknown token: keep the defaults rather than guessing. A typo in an env
    // var must not silently disable the guard the user asked for.
    return {
      policy: DEFAULT_PORTABLE_PATH_POLICY,
      charset: DEFAULT_PORTABLE_PATH_CHARSET,
    };
  }

  // "strict-ascii" alone means "enforce, ASCII-only".
  if (!sawPolicy && charset === "strict-ascii") {
    policy = "error";
  }

  return { policy, charset };
}

/** Decode percent-encoded input the way {@link SafePath} does before validating. */
function decodeLike(value: string): string {
  let decoded = value;
  let prev: string;
  do {
    prev = decoded;
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      return prev;
    }
  } while (decoded !== prev);
  return decoded;
}

function isControlCharacter(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code <= 0x1f || code === 0x7f;
}

function isAscii(char: string): boolean {
  return (char.codePointAt(0) ?? 0) <= 0x7f;
}

/**
 * Check a single path segment (file or directory name) against the
 * cross-platform rules. Returns every violation found, so a caller can report
 * all problems at once instead of one per attempt.
 */
export function findSegmentViolations(
  segment: string,
  options?: { path?: string; segmentIndex?: number; charset?: PortablePathCharset },
): PortabilityViolation[] {
  const path = options?.path ?? segment;
  const segmentIndex = options?.segmentIndex ?? 0;
  const charset = options?.charset ?? DEFAULT_PORTABLE_PATH_CHARSET;
  const violations: PortabilityViolation[] = [];

  const push = (code: PortabilityViolationCode, detail: string): void => {
    violations.push({ path, segment, segmentIndex, code, detail });
  };

  // Validate what Windows would actually receive: SafePath decodes the path
  // (so "%3A" becomes ":") before resolving it.
  const decoded = decodeLike(segment);

  const reservedFound: string[] = [];
  const controlFound: string[] = [];
  const nonAsciiFound: string[] = [];

  for (const char of decoded) {
    if (RESERVED_CHARACTERS.has(char)) reservedFound.push(char);
    else if (isControlCharacter(char)) controlFound.push(char);
    else if (!isAscii(char)) nonAsciiFound.push(char);
  }

  if (reservedFound.length > 0) {
    push(
      "RESERVED_CHARACTER",
      `contains character(s) Windows forbids: ${[...new Set(reservedFound)]
        .map((char) => JSON.stringify(char))
        .join(", ")}`,
    );
  }

  if (controlFound.length > 0) {
    push("CONTROL_CHARACTER", "contains control character(s) (0x00–0x1F, 0x7F)");
  }

  const trimmed = decoded.replace(/[. ]+$/, "");
  if (trimmed !== decoded && decoded.length > 0) {
    const trailing = decoded.slice(trimmed.length);
    push(
      "TRAILING_DOT_OR_SPACE",
      `ends with ${[...trailing]
        .map((char) => JSON.stringify(char))
        .join(", ")}, which Windows drops silently`,
    );
  }

  // Windows ignores the extension when matching device names: "aux.md" is
  // still the AUX device.
  const deviceBase = decoded.split(".")[0]?.toLowerCase() ?? "";
  if (RESERVED_DEVICE_NAMES.has(deviceBase)) {
    push(
      "RESERVED_DEVICE_NAME",
      `"${decoded}" resolves to the reserved Windows device name ${deviceBase.toUpperCase()}`,
    );
  }

  if ([...decoded].length > MAX_SEGMENT_LENGTH) {
    push(
      "NAME_TOO_LONG",
      `is ${[...decoded].length} characters long, the limit is ${MAX_SEGMENT_LENGTH}`,
    );
  }

  if (charset === "strict-ascii" && nonAsciiFound.length > 0) {
    const sample = [...new Set(nonAsciiFound)].slice(0, 5).join("");
    push(
      "NON_ASCII_NAME",
      `contains non-ASCII character(s) ${JSON.stringify(sample)} (strict-ascii policy)`,
    );
  }

  return violations;
}

/**
 * Check a vault-relative path (slash- or backslash-separated) segment by
 * segment. `""` and `"."` segments are ignored — they carry no name.
 */
export function findPathViolations(
  relativePath: string,
  options?: { charset?: PortablePathCharset },
): PortabilityViolation[] {
  const charset = options?.charset ?? DEFAULT_PORTABLE_PATH_CHARSET;
  const segments = relativePath.split(/[/\\]+/);
  const violations: PortabilityViolation[] = [];

  segments.forEach((segment, index) => {
    if (segment.length === 0 || segment === ".") return;
    violations.push(
      ...findSegmentViolations(segment, { path: relativePath, segmentIndex: index, charset }),
    );
  });

  return violations;
}

/** True when the path contains no violation (convenience predicate). */
export function isPortablePath(
  relativePath: string,
  options?: { charset?: PortablePathCharset },
): boolean {
  return findPathViolations(relativePath, options).length === 0;
}

/** Render violations as short, agent-readable lines. */
export function describePortabilityViolations(
  violations: readonly PortabilityViolation[],
): string[] {
  return violations.map(
    (violation) => `${violation.segment}: ${violation.detail} [${violation.code}]`,
  );
}
