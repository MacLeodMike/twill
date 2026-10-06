// Overlay persistence (T2a Task 3) — the writable overlay (workspace §8) as
// a JSONL file at `<documentsDir>/.twill-overlay.jsonl`. Each line is the
// full raw document envelope as JSON (the same object a watched file's
// parsed YAML would carry); `append` writes one line synchronously and
// `load` reduces the file latest-per-name (a later line for the same
// `"<Kind>/<name>"` replaces the earlier — claim releases work this way).
//
// Trust model (T2a-1 ledger ruling, carried into Task 3): overlay documents
// were validated at append time (the claim validators + the store's
// write-time rejectCheck), so `load` does NOT run them through the loader's
// inert-marking envelope validation as if they were watched documents.
// Loading re-validates minimally — the line must parse as JSON and carry a
// non-empty `kind` and `metadata.name` — and then trusts the envelope,
// projecting it with the loader's field projection (`projectDocument`) with
// `resolvable: true` and no inert reasons.
//
// Failure model: a missing file is an empty overlay, never an error. A line
// that fails JSON.parse (partial write) or lacks the minimal envelope is
// skipped with an `overlay-corrupt-line` warning naming the 1-indexed line;
// the rest of the file still loads — overlay corruption never crashes the
// registry. Any other read error (permissions, EIO) is a deployment fault
// and throws out of `load` rather than silently serving an empty overlay
// (claims would vanish from discovery with no signal).
//
// The file is only read at store construction. The in-memory overlay Map is
// authoritative while the store runs (the file only ever grows through
// `append`, which keeps memory and disk in the same call); external edits
// or corruption mid-run surface at the next process start.

import { appendFileSync, readFileSync } from "node:fs";
import { isRecord, type FabricDocument } from "./document.js";
import { projectDocument } from "./loader.js";

/** The overlay filename inside the documents directory. */
export const OVERLAY_FILENAME = ".twill-overlay.jsonl";

/**
 * Registry health warnings (workspace §8's `warnings` array). Both variants
 * are overlay-sourced: a corrupt overlay line, and an overlay document
 * shadowing a watched document of the same `"<Kind>/<name>"`.
 */
export type Warning =
  | { type: "overlay-shadow"; name: string }
  | { type: "overlay-corrupt-line"; line: number };

export type OverlayLoadResult = { documents: FabricDocument[]; warnings: Warning[] };

export class OverlayStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /**
   * Read the overlay file and reduce it latest-per-name. Missing file →
   * empty overlay. Corrupt lines → skipped with warnings, rest loads.
   */
  load(): OverlayLoadResult {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return { documents: [], warnings: [] };
      throw err;
    }

    const documents = new Map<string, FabricDocument>();
    const warnings: Warning[] = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim() === "") continue; // trailing newline / blank-line tolerance
      const lineNo = i + 1;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        warnings.push({ type: "overlay-corrupt-line", line: lineNo });
        continue;
      }
      const doc = overlayDocument(raw);
      if (doc === undefined) {
        // Parseable but not a minimal envelope — same corrupt-line
        // treatment: skip with a warning, keep loading the rest.
        warnings.push({ type: "overlay-corrupt-line", line: lineNo });
        continue;
      }
      // Latest-per-name: a later line for the same key replaces the earlier.
      documents.set(`${doc.kind}/${doc.name}`, doc);
    }
    return { documents: [...documents.values()], warnings };
  }

  /**
   * Append one line — the full raw envelope as JSON — synchronously. The
   * caller (RegistryStore.appendOverlay) runs this after write-time
   * validation and before the in-memory update, so a failed write leaves
   * memory untouched.
   */
  append(doc: FabricDocument): void {
    appendFileSync(this.path, `${JSON.stringify(doc.raw)}\n`, "utf8");
  }
}

/**
 * Minimal re-validation + trusted projection for an overlay line (see the
 * header's trust model): the envelope must carry a non-empty `kind` string
 * and a non-empty `metadata.name` — without those the document cannot be
 * keyed, so the line is corrupt. Everything else is trusted as appended.
 */
function overlayDocument(raw: unknown): FabricDocument | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw["kind"] !== "string" || raw["kind"] === "") return undefined;
  const metadata = raw["metadata"];
  if (!isRecord(metadata) || typeof metadata["name"] !== "string" || metadata["name"] === "") {
    return undefined;
  }
  return projectDocument(raw, "<overlay>");
}
