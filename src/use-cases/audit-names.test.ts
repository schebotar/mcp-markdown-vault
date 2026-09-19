import { describe, it, expect } from "vitest";
import { AuditNamesUseCase } from "./audit-names.js";
import type {
  IFileSystemAdapter,
  NoteStat,
} from "../domain/interfaces/file-system-adapter.js";

/** Minimal adapter stub: the audit is pure logic over `listNotes`. */
function stubAdapter(notes: string[]): IFileSystemAdapter {
  return {
    listNotes: async (directory?: string) =>
      directory === undefined
        ? notes
        : notes.filter((note) => note.startsWith(`${directory.replace(/\/+$/, "")}/`)),
    readNote: async () => "",
    writeNote: async () => {},
    deleteNote: async () => {},
    exists: async () => false,
    stat: async (): Promise<NoteStat> => ({ sizeBytes: 0, modifiedAt: "" }),
  };
}

const CLEAN = "Встречи/2026-09-15 Заметка.md";
const RESERVED_CHAR = "Встречи/12:30.md";
const DEVICE_NAME = "aux.md";
const TRAILING_SPACE = "note.md ";
const CYRILLIC = "Заметки/идея.md";

describe("AuditNamesUseCase", () => {
  it("reports nothing for a portable vault", async () => {
    const result = await new AuditNamesUseCase(stubAdapter([CLEAN, CYRILLIC])).execute();

    expect(result).toMatchObject({
      scannedFiles: 2,
      nonPortableCount: 0,
      returned: 0,
      truncated: false,
      charset: "unicode",
    });
    expect(result.notes).toEqual([]);
  });

  it("lists notes whose names Windows rejects, with the reason", async () => {
    const result = await new AuditNamesUseCase(
      stubAdapter([CLEAN, RESERVED_CHAR, DEVICE_NAME]),
    ).execute();

    expect(result.scannedFiles).toBe(3);
    expect(result.nonPortableCount).toBe(2);
    expect(result.notes.map((note) => note.path)).toEqual([
      RESERVED_CHAR,
      DEVICE_NAME,
    ]);
    expect(result.notes[0]?.violations[0]?.code).toBe("RESERVED_CHARACTER");
    expect(result.notes[1]?.violations[0]?.code).toBe("RESERVED_DEVICE_NAME");
  });

  it("reports each rule separately (trailing dot/space, reserved character)", async () => {
    const result = await new AuditNamesUseCase(stubAdapter([TRAILING_SPACE])).execute();

    expect(result.nonPortableCount).toBe(1);
    expect(result.notes[0]?.violations[0]?.code).toBe("TRAILING_DOT_OR_SPACE");
  });

  it("flags non-ASCII names only under strict-ascii", async () => {
    // Cyrillic names are legal on Windows, so only strict-ascii reports them.
    const adapter = stubAdapter([CYRILLIC, "notes/ascii.md"]);

    const unicode = await new AuditNamesUseCase(adapter).execute({ charset: "unicode" });
    expect(unicode.nonPortableCount).toBe(0);

    const strict = await new AuditNamesUseCase(adapter).execute({ charset: "strict-ascii" });
    expect(strict.scannedFiles).toBe(2);
    expect(strict.nonPortableCount).toBe(1);
    expect(strict.notes[0]?.path).toBe(CYRILLIC);
    expect(strict.charset).toBe("strict-ascii");
  });

  it("scopes the scan to a directory", async () => {
    const result = await new AuditNamesUseCase(
      stubAdapter([CLEAN, RESERVED_CHAR, DEVICE_NAME]),
    ).execute({ directory: "Встречи" });

    expect(result.scannedFiles).toBe(2);
    expect(result.notes.map((note) => note.path)).toEqual([RESERVED_CHAR]);
  });

  it("caps the returned list and reports truncation", async () => {
    const notes = Array.from({ length: 5 }, (_, i) => `bad:name-${i}.md`);
    const result = await new AuditNamesUseCase(stubAdapter(notes)).execute({ limit: 2 });

    expect(result.nonPortableCount).toBe(5);
    expect(result.returned).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.notes).toHaveLength(2);
  });

  it("flags a non-portable directory segment for every note inside it", async () => {
    const result = await new AuditNamesUseCase(
      stubAdapter(["12:30/note.md", "12:30/other.md"]),
    ).execute();

    expect(result.nonPortableCount).toBe(2);
    expect(result.notes[0]?.violations[0]?.segment).toBe("12:30");
  });
});
