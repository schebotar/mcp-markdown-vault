import type { IFileSystemAdapter } from "../domain/interfaces/file-system-adapter.js";
import { FreeformEditor } from "./freeform-editor.js";

/** A single self-test step result. */
export interface SelftestStep {
  name: string;
  ok: boolean;
  detail?: string | undefined;
}

/** Overall self-test result. */
export interface SelftestResult {
  status: "PASS" | "FAIL";
  steps: SelftestStep[];
}

const FILE = ".mcp_selftest.md";
const INITIAL_LINE = "Line with \\[\\[Agent/x]] and \\_text and — em dash and кириллица";
const REPLACEMENT = "Replaced \\[\\[Agent/y]] and \\_ kept";

/**
 * In-vault self test for the string round-trip:
 * create → string_replace (escaped chars) → line_replace (expectLine) →
 * read → delete. Makes P1-class escaping/matching mismatches visible without
 * user involvement.
 */
export class SelftestUseCase {
  constructor(private readonly fsAdapter: IFileSystemAdapter) {}

  async execute(): Promise<SelftestResult> {
    const steps: SelftestStep[] = [];
    const run = async (name: string, fn: () => Promise<void>): Promise<void> => {
      try {
        await fn();
        steps.push({ name, ok: true });
      } catch (err) {
        steps.push({
          name,
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    };

    const initial = `# Self Test\n\n${INITIAL_LINE}\n\nSecond line.\n`;

    try {
      await run("create", async () => {
        await this.fsAdapter.writeNote(FILE, initial, true);
      });

      await run("string_replace (escaped chars)", async () => {
        const source = await this.fsAdapter.readNote(FILE);
        const updated = FreeformEditor.stringReplace(source, INITIAL_LINE, REPLACEMENT, false);
        await this.fsAdapter.writeNote(FILE, updated, true);
        const readBack = await this.fsAdapter.readNote(FILE);
        if (!readBack.includes(REPLACEMENT)) {
          throw new Error("replacement not found after string_replace");
        }
      });

      await run("line_replace with expectLine", async () => {
        const source = await this.fsAdapter.readNote(FILE);
        FreeformEditor.assertLine(source, 1, "# Self Test");
        const updated = FreeformEditor.lineReplace(source, 1, 1, "# Self Test (verified)");
        await this.fsAdapter.writeNote(FILE, updated, true);
        const readBack = await this.fsAdapter.readNote(FILE);
        if (!readBack.includes("# Self Test (verified)")) {
          throw new Error("line_replace did not apply");
        }
      });

      await run("read round-trip", async () => {
        const readBack = await this.fsAdapter.readNote(FILE);
        if (!readBack.includes("\\[\\[Agent/y]]")) {
          throw new Error("escaped wiki-link was altered on read");
        }
      });
    } finally {
      try {
        await this.fsAdapter.deleteNote(FILE);
      } catch {
        // best-effort cleanup
      }
    }

    return {
      status: steps.every((step) => step.ok) ? "PASS" : "FAIL",
      steps,
    };
  }
}
