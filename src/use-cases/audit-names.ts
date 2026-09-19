/**
 * Read-only audit of existing vault names.
 *
 * The creation guard in {@link LocalFileSystemAdapter} only protects *new*
 * notes. A vault that has been in use for a while (or that was filled from
 * another machine) can already contain names Windows refuses — those files
 * never reach the Windows laptop, and the sync engine reports them as failed
 * or as conflicts. This use case lists them so they can be renamed.
 */

import type { IFileSystemAdapter } from "../domain/interfaces/file-system-adapter.js";
import type {
  PortabilityViolation,
  PortablePathCharset,
} from "../domain/value-objects/index.js";
import { findPathViolations } from "../domain/value-objects/index.js";

/** Request DTO for {@link AuditNamesUseCase}. */
export interface AuditNamesRequest {
  /** Vault-relative directory to limit the audit to (default: whole vault). */
  directory?: string | undefined;
  /** Also flag non-ASCII names (see `portable-path.ts`). */
  charset?: PortablePathCharset | undefined;
  /** Maximum number of offending paths to list (default 100). */
  limit?: number | undefined;
}

/** One offending note with every rule it breaks. */
export interface NonPortableNote {
  path: string;
  violations: PortabilityViolation[];
}

/** Response DTO for {@link AuditNamesUseCase}. */
export interface AuditNamesResponse {
  scannedFiles: number;
  nonPortableCount: number;
  returned: number;
  truncated: boolean;
  charset: PortablePathCharset;
  notes: NonPortableNote[];
}

/** Contract for the AuditNames use case. */
export interface IAuditNamesUseCase {
  execute(request?: AuditNamesRequest): Promise<AuditNamesResponse>;
}

const DEFAULT_LIMIT = 100;

export class AuditNamesUseCase implements IAuditNamesUseCase {
  constructor(private readonly fsAdapter: IFileSystemAdapter) {}

  async execute(request?: AuditNamesRequest): Promise<AuditNamesResponse> {
    const charset: PortablePathCharset = request?.charset ?? "unicode";
    const limit = request?.limit ?? DEFAULT_LIMIT;

    const paths = await this.fsAdapter.listNotes(request?.directory);

    const offenders: NonPortableNote[] = [];
    for (const notePath of paths) {
      const violations = findPathViolations(notePath, { charset });
      if (violations.length > 0) {
        offenders.push({ path: notePath, violations });
      }
    }

    return {
      scannedFiles: paths.length,
      nonPortableCount: offenders.length,
      returned: Math.min(offenders.length, limit),
      truncated: offenders.length > limit,
      charset,
      notes: offenders.slice(0, limit),
    };
  }
}
