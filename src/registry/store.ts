// Registry store (Task 5) — the watched documents directory, reload
// semantics, and the last-good snapshot protocol (core §8.3 + workspace §8).
//
// The snapshot is the consistency unit: a reload builds the new snapshot
// completely (loadDirectory → rejectCheck → overlay merge) and swaps it in
// with a single assignment, so a resolver holding an old Snapshot object
// sees a stable world across reloads (Review Focus #4). A *rejected* reload
// swaps nothing — the last-good snapshot keeps being served and health()
// reports `documentSet: "stale"` with the reject reason. A cold start on a
// rejected set serves an empty snapshot (generation 0), also `stale`.
//
// The writable overlay (workspace §8): API-written documents (Claims in
// T2a) live in `overlay`, an in-memory Map keyed on `"<Kind>/<name>"` that
// `appendOverlay` writes through — every append validates the merged set
// (watched ∪ overlay ∪ new) with rejectCheck *before* writing, so one bad
// write cannot poison every subsequent reload. The merged snapshot is the
// union with the overlay winning on name collision (§8.3's document set
// means the union). The overlay is persisted (Task 3) as a JSONL file at
// `<documentsDir>/.twill-overlay.jsonl` behind OverlayStore: read once at
// start, appended synchronously on every accepted `appendOverlay`.
//
// RegistryStore satisfies the resolver's ResolveStore interface:
// `get(kind, name)` answers from the current snapshot and `statusCache` is
// the shared StatusCache instance (never swapped — it is provider report
// state, not part of a document-set snapshot).

import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { KINDS, type FabricDocument, type Kind } from "./document.js";
import { loadDirectory, type LoadProblem } from "./loader.js";
import { documentKey, rejectCheck } from "./lineage.js";
import { OverlayStore, OVERLAY_FILENAME, type Warning } from "./overlay.js";
import type { StatusCache } from "./status.js";

/** An immutable view of the document set; the consistency unit for readers. */
export type Snapshot = {
  documents: FabricDocument[];
  byName: Map<string, FabricDocument>;
  generation: number;
};

// The `Warning` union (overlay-shadow / overlay-corrupt-line) lives in
// overlay.ts — both variants are overlay-sourced.
export type { Warning } from "./overlay.js";

export type HealthReport = {
  documentSet: "current" | "stale";
  rejectedAt?: string;
  reason?: string;
  warnings: Warning[];
};

/** The current/stale half of the health report (warnings live separately). */
type ServedHealth = { documentSet: "current" | "stale"; rejectedAt?: string; reason?: string };

/** The watched source is read-only: reloads replace in-memory state only. */
const RELOAD_DEBOUNCE_MS = 100;

// The empty snapshot served before the first accepted load (generation 0).
// Never handed out mutated: snapshots are replaced wholesale, never edited.
const EMPTY_SNAPSHOT: Snapshot = { documents: [], byName: new Map(), generation: 0 };

export class RegistryStore {
  /** The current (accepted, or empty-on-cold-reject) snapshot. */
  private snapshot: Snapshot;

  /** Health over the last accepted (or cold-start) set; warnings live in `this.warnings`. */
  private report: ServedHealth;

  /** Load problems of the last accepted load — informational only. */
  readonly problems: LoadProblem[];

  /** Provider report cache (core §8) — not part of snapshot swaps. */
  readonly statusCache: StatusCache = new Map();

  private watchers: FSWatcher[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly dir: string;

  /**
   * The writable overlay (workspace §8): API-written documents, keyed on
   * `"<Kind>/<name>"`, merged over the watched set on every accepted
   * (re)load. Persisted by `overlayStore`: the in-memory map is seeded from
   * the JSONL file at construction and every accepted append writes the
   * file line first, then updates the map, in the same synchronous call.
   */
  private readonly overlay = new Map<string, FabricDocument>();
  private readonly overlayStore: OverlayStore;

  /** Corrupt-line warnings from the start-time overlay read (persist for the store's run). */
  private readonly overlayLoadWarnings: Warning[];

  /**
   * The watched documents of the last accepted (re)load — needed for the
   * overlay-shadow warnings, which compare watched names against overlay
   * names. Empty until the first accepted load; a rejected reload keeps the
   * previous value (consistent with the last-good snapshot being served).
   */
  private watched: FabricDocument[] = [];

  /**
   * The warnings health() serves: overlay-load warnings plus the shadowing
   * warnings of the currently served set. Recomputed on every accepted
   * (re)load and overlay append; a rejected reload keeps them (they
   * describe the last-good set still being served).
   */
  private warnings: Warning[];

  /**
   * Prefer `start(dir)` — the conventional entry that documents cold-start
   * semantics. `overlayPath` overrides the overlay file location
   * (production default: `<dir>/.twill-overlay.jsonl`, beside the watched
   * documents; tests pass a temp path when the documents dir must stay
   * pristine).
   */
  constructor(dir: string, overlayPath?: string) {
    this.dir = dir;
    this.overlayStore = new OverlayStore(overlayPath ?? join(dir, OVERLAY_FILENAME));
    const loaded = this.overlayStore.load();
    this.overlayLoadWarnings = loaded.warnings;
    for (const doc of loaded.documents) {
      this.overlay.set(documentKey(doc), doc);
    }
    this.warnings = [...this.overlayLoadWarnings];
    this.problems = [];
    this.snapshot = EMPTY_SNAPSHOT;
    this.report = { documentSet: "current" };
    this.reload();
    this.setupWatchers();
  }

  /** Current snapshot. A reload never mutates a snapshot a reader holds. */
  current(): Snapshot {
    return this.snapshot;
  }

  /** Document by `"<Kind>/<name>"` from the current snapshot. */
  get(kind: Kind, name: string): FabricDocument | undefined {
    return this.snapshot.byName.get(`${kind}/${name}`);
  }

  health(): HealthReport {
    const { documentSet, rejectedAt, reason } = this.report;
    const health: HealthReport = { documentSet, warnings: [...this.warnings] };
    if (documentSet === "stale") {
      health.rejectedAt = rejectedAt;
      health.reason = reason;
    }
    return health;
  }

  /**
   * Reload now (the initial load and the debounced watcher callback both
   * run through here). On reject the last-good snapshot stays and health
   * turns stale; on accept a fully-built snapshot replaces the old one in a
   * single assignment and the generation increments.
   */
  reload(): void {
    if (this.closed) return;

    const { documents, problems } = loadDirectory(this.dir);
    this.problems.splice(0, this.problems.length, ...problems);

    // The overlay merges over the watched set (workspace §8: the document
    // set is watched ∪ overlay, overlay wins on name collision) and the
    // merged set is what gets reject-checked — §8.3's set means the union.
    const merged = mergeOverlay(documents, this.overlay);
    const rejection = rejectCheck(merged);
    if (rejection.rejected) {
      const rejectedAt = new Date().toISOString();
      // eslint-disable-next-line no-console
      console.warn(
        `[twill] documents directory reload rejected; serving ${
          this.snapshot === EMPTY_SNAPSHOT ? "the empty registry" : "the last-good snapshot"
        } (${this.snapshot.documents.length} documents): ${rejection.reason ?? "unknown reason"}`,
      );
      // Warnings are left alone: they describe the set still being served.
      this.report = { documentSet: "stale", rejectedAt, reason: rejection.reason };
      return;
    }

    // The snapshot is the atomicity unit: built fully, then a single swap.
    this.watched = documents;
    this.snapshot = buildSnapshot(merged, this.snapshot.generation + 1);
    this.warnings = [...this.overlayLoadWarnings, ...shadowWarnings(documents, this.overlay)];
    this.report = { documentSet: "current" };
  }

  /**
   * The overlay write seam (workspace §8): validate the merged set
   * (watched ∪ overlay ∪ `doc`, overlay winning on name collision) through
   * rejectCheck *before* appending; on violation return the error and
   * change nothing. On success the document is appended to the overlay
   * FILE and the in-memory map updated synchronously within this call
   * (file first: a failed write throws before any in-memory state changes,
   * so the store never serves a document it did not persist), and the
   * merged snapshot is rebuilt and swapped in a single assignment
   * (generation increments), so resolution and discovery see the document
   * immediately.
   */
  appendOverlay(doc: FabricDocument): { ok: boolean; error?: string } {
    const merged = mergeOverlay(this.snapshot.documents, this.overlay, doc);
    const rejection = rejectCheck(merged);
    if (rejection.rejected) {
      return { ok: false, error: rejection.reason ?? "merged document set rejected" };
    }
    this.overlayStore.append(doc);
    this.overlay.set(documentKey(doc), doc);
    this.snapshot = buildSnapshot(merged, this.snapshot.generation + 1);
    this.warnings = [...this.overlayLoadWarnings, ...shadowWarnings(this.watched, this.overlay)];
    return { ok: true };
  }

  /** Stop watchers and any pending debounce; the store becomes inert. */
  close(): void {
    this.closed = true;
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    for (const watcher of this.watchers.splice(0)) {
      try {
        watcher.close();
      } catch {
        // already closed
      }
    }
  }

  private scheduleReload(): void {
    if (this.closed) return;
    if (this.debounceTimer !== null) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.reload();
    }, RELOAD_DEBOUNCE_MS);
    this.debounceTimer.unref?.();
  }

  /**
   * Preferred: one recursive watch on the documents directory. Some
   * platform/node combinations reject `recursive` (e.g. ERR_FEATURE_-
   * UNAVAILABLE_ON_PLATFORM) — then fall back to one watcher per kind
   * subdirectory that exists. Watcher setup failure never throws (the
   * store still serves; the operator can reload via the CLI/HTTP surface).
   */
  private setupWatchers(): void {
    try {
      this.watchers.push(watch(this.dir, { recursive: true }, () => this.scheduleReload()));
      return;
    } catch (err) {
      if (!isRecursiveUnavailable(err)) {
        // Unknown failure — don't crash the store; note and continue.
        // eslint-disable-next-line no-console
        console.warn(`[twill] directory watcher setup failed: ${String(err)}`);
        return;
      }
    }
    // Fallback: per-kind subdirectory watchers.
    for (const kind of KINDS) {
      try {
        this.watchers.push(watch(join(this.dir, kind), () => this.scheduleReload()));
      } catch {
        // Kind subdirectory absent (or unreadable) — nothing to watch there.
      }
    }
  }
}

/** The union watched ∪ overlay (∪ an optional pending doc): later entries
 * win on `"<Kind>/<name>"` collision (workspace §8: overlay wins). */
function mergeOverlay(
  watched: readonly FabricDocument[],
  overlay: ReadonlyMap<string, FabricDocument>,
  pending?: FabricDocument,
): FabricDocument[] {
  const merged = new Map<string, FabricDocument>();
  for (const doc of watched) merged.set(documentKey(doc), doc);
  for (const [key, doc] of overlay) merged.set(key, doc);
  if (pending !== undefined) merged.set(documentKey(pending), pending);
  return [...merged.values()];
}

/**
 * The shadowing warnings (workspace §8): one `overlay-shadow` warning per
 * overlay document whose `"<Kind>/<name>"` also names a watched document —
 * the overlay version is the one served.
 */
function shadowWarnings(
  watched: readonly FabricDocument[],
  overlay: ReadonlyMap<string, FabricDocument>,
): Warning[] {
  if (overlay.size === 0) return [];
  const watchedKeys = new Set(watched.map(documentKey));
  const warnings: Warning[] = [];
  for (const key of overlay.keys()) {
    if (watchedKeys.has(key)) warnings.push({ type: "overlay-shadow", name: key });
  }
  return warnings;
}

/** A snapshot over a merged document list (union already computed). */
function buildSnapshot(documents: FabricDocument[], generation: number): Snapshot {
  const byName = new Map<string, FabricDocument>();
  for (const doc of documents) byName.set(documentKey(doc), doc);
  return { documents, byName, generation };
}

/** Was the recursive watch rejected for the platform (not our path being bad)? */
function isRecursiveUnavailable(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM"
  );
}

/**
 * Open a store on `dir`: loads the persisted overlay (default
 * `<dir>/.twill-overlay.jsonl`; `overlayPath` overrides), performs the
 * initial reload with the overlay merged over the watched set (last-good /
 * empty-on-reject semantics apply to this cold start too), and begins
 * watching with debounced reloads.
 */
export function start(dir: string, overlayPath?: string): RegistryStore {
  return new RegistryStore(dir, overlayPath);
}
