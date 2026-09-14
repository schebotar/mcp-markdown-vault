import type { IFileSystemAdapter } from "../domain/interfaces/file-system-adapter.js";
import type { IDiffService } from "../domain/interfaces/diff-service.js";

/** Result of normalizing escaped wiki-links in a note. */
export interface NormalizeWikilinksResult {
  content: string;
  replacements: number;
}

/**
 * Canonical wiki-links are `[[...]]` (unescaped). Models sometimes emit the
 * escaped form `\[\[...]]`; this removes the backslash before `[` or `]`.
 */
export function normalizeWikilinks(content: string): NormalizeWikilinksResult {
  let replacements = 0;
  const normalized = content.replace(/\\([\[\]])/g, (_match, char: string) => {
    replacements++;
    return char;
  });
  return { content: normalized, replacements };
}

/** Request DTO for {@link NormalizeLinksUseCase}. */
export interface NormalizeLinksRequest {
  path: string;
  /** When true (default) only a diff is returned and nothing is written. */
  dryRun?: boolean | undefined;
}

/** Response DTO for {@link NormalizeLinksUseCase}. */
export interface NormalizeLinksResponse {
  path: string;
  replacements: number;
  dryRun: boolean;
  diff?: string | undefined;
}

/**
 * Normalizes escaped wiki-links in a note, previewing by default.
 */
export class NormalizeLinksUseCase {
  constructor(
    private readonly fsAdapter: IFileSystemAdapter,
    private readonly diffService: IDiffService,
  ) {}

  async execute(request: NormalizeLinksRequest): Promise<NormalizeLinksResponse> {
    const dryRun = request.dryRun ?? true;
    const source = await this.fsAdapter.readNote(request.path);
    const { content, replacements } = normalizeWikilinks(source);

    if (dryRun) {
      return {
        path: request.path,
        replacements,
        dryRun: true,
        diff: this.diffService.generateDiff(source, content, request.path),
      };
    }

    if (replacements > 0) {
      await this.fsAdapter.writeNote(request.path, content, true);
    }
    return { path: request.path, replacements, dryRun: false };
  }
}
