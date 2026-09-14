import crypto from "node:crypto";
import type { IFileSystemAdapter } from "../domain/interfaces/file-system-adapter.js";

/** Lightweight, agent-safe identity of a note file. */
export interface FileFingerprint {
  /** File size in bytes. */
  sizeBytes: number;
  /** Last modification time as an ISO-8601 string. */
  mtime: string;
  /** First 12 hex characters of the SHA-256 of the raw file content. */
  sha256: string;
}

/** Short SHA-256 (12 hex chars) of a string, matching {@link FileFingerprint.sha256}. */
export function sha256Short(content: string): string {
  return crypto.createHash("sha256").update(content, "utf-8").digest("hex").slice(0, 12);
}

/**
 * Compute a stable fingerprint used for drift detection: agents can compare
 * it across calls to confirm the server sees the same file version.
 *
 * @param content Optional already-read content, to avoid a second read.
 */
export async function fingerprintNote(
  fsAdapter: IFileSystemAdapter,
  notePath: string,
  content?: string,
): Promise<FileFingerprint> {
  const [raw, stat] = await Promise.all([
    content === undefined ? fsAdapter.readNote(notePath) : Promise.resolve(content),
    fsAdapter.stat(notePath),
  ]);
  return {
    sizeBytes: Buffer.byteLength(raw, "utf-8"),
    mtime: stat.modifiedAt,
    sha256: sha256Short(raw),
  };
}
