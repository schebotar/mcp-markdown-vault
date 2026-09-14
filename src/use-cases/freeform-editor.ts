import { FreeformEditError } from "../domain/errors/index.js";

/**
 * Freeform (non-AST) editing operations.
 *
 * Provides line-range replacement and string find/replace as a fallback
 * for content that doesn't have heading or block ID anchors.
 */
export class FreeformEditor {
  /**
   * Replace a range of lines (1-based, inclusive) with new content.
   */
  static lineReplace(
    source: string,
    startLine: number,
    endLine: number,
    content: string,
  ): string {
    if (typeof content !== "string") {
      throw new FreeformEditError(
        `Replacement content must be a string, got: ${String(content)}`,
      );
    }
    const lines = source.split("\n");

    if (startLine < 1) {
      throw new FreeformEditError(
        `startLine must be >= 1, got ${startLine}`,
      );
    }
    if (endLine > lines.length) {
      throw new FreeformEditError(
        `endLine ${endLine} exceeds file length (${lines.length} lines)`,
      );
    }
    if (startLine > endLine) {
      throw new FreeformEditError(
        `startLine (${startLine}) must be <= endLine (${endLine})`,
      );
    }

    const newLines = content.split("\n");
    lines.splice(startLine - 1, endLine - startLine + 1, ...newLines);
    return lines.join("\n");
  }

  /**
   * Assert that a 1-based line contains `expectLine` (after trimming both).
   * Guards `line_replace` against file drift: if the file shifted between the
   * read and the edit, the caller gets the actual line content instead of
   * silently replacing the wrong line.
   */
  static assertLine(
    source: string,
    lineNumber: number,
    expectLine: string,
  ): void {
    const lines = source.split("\n");
    if (lineNumber < 1 || lineNumber > lines.length) {
      throw new FreeformEditError(
        `Line ${lineNumber} is out of range (file has ${lines.length} lines)`,
      );
    }
    const actual = lines[lineNumber - 1] ?? "";
    if (!actual.trim().includes(expectLine.trim())) {
      throw new FreeformEditError(
        `Line ${lineNumber} does not match expectLine. Actual: ${JSON.stringify(actual)}`,
      );
    }
  }

  /**
   * Find and replace a literal string. Uses exact string matching
   * (no regex) to avoid brittle patterns.
   */
  static stringReplace(
    source: string,
    search: string,
    replace: string,
    replaceAll?: boolean,
  ): string {
    if (typeof replace !== "string") {
      throw new FreeformEditError(
        `Replacement content must be a string, got: ${String(replace)}`,
      );
    }
    if (!source.includes(search)) {
      throw new FreeformEditError(`Search string not found: "${search}"`);
    }

    if (replaceAll) {
      return source.split(search).join(replace);
    }

    // Replace first occurrence only
    const idx = source.indexOf(search);
    return source.slice(0, idx) + replace + source.slice(idx + search.length);
  }
}
