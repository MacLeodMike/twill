// Registry store (Task 5) — the watched documents directory, reload
// semantics, and the last-good snapshot protocol (core §8.3 + workspace §8).
//
// The snapshot is the consistency unit: a reload builds the new snapshot
// completely (loadDirectory → rejectCheck) and swaps it in with a single
// assignment, so a resolver holding an old Snapshot object sees a stable
// world across reloads (Review Focus #4). A *rejected* reload swaps nothing —
// the last-good snapshot keeps being served and health() reports
// `documentSet: "stale"` with the reject reason. A cold start on a rejected
// set serves an empty snapshot (generation 0), also `stale`.
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
import type { StatusCache } from "./status.js";

/** An immutable view of the document set; the consistency unit for readers. */
export type Snapshot = {
  documents: FabricDocument[];
  byName: Map<string, FabricDocument>;
  generation: number;
};

/** Non-fingerprint registry warnings (empty in T1 — claims are 501). */
export type Warning = { message: string };

export type HealthReport = {
  documentSet: "current" | "stale";
  rejectedAt?: string;
  reason?: string;
  warnings: Warning[];
};

/** The watched source is read-only: reloads replace in-memory state only. */
const RELOAD_DEBOUNCE_MS = 100;

// The empty snapshot served before the first accepted load (generation 0).
// Never handed out mutated: snapshots are replaced wholesale, never edited.
const EMPTY_SNAPSHOT: Snapshot = { documents: [], byName: new Map(), generation: 0 };

export class RegistryStore {
  /** The current (accepted, or empty-on-cold-reject) snapshot. */
  private snapshot: Snapshot;

  /** Health over the last accepted (or cold-start) set. */
  private report: HealthReport;

  /** Load problems of the last accepted load — informational only. */
  readonly problems: LoadProblem[];

  /** Provider report cache (core §8) — not part of snapshot swaps. */
  readonly statusCache: StatusCache = new Map();

  private watchers: FSWatcher[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly dir: string;

  /** Prefer `start(dir)` — the conventional entry that documents cold-start semantics. */
  constructor(dir: string) {
    this.dir = dir;
    this.problems = [];
    this.snapshot = EMPTY_SNAPSHOT;
    this.report = { documentSet: "current", warnings: [] };
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
    const health: HealthReport = { documentSet, warnings: [] };
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

    const rejection = rejectCheck(documents);
    if (rejection.rejected) {
      const rejectedAt = new Date().toISOString();
      // eslint-disable-next-line no-console
      console.warn(
        `[twill] documents directory reload rejected; serving ${
          this.snapshot === EMPTY_SNAPSHOT ? "the empty registry" : "the last-good snapshot"
        } (${this.snapshot.documents.length} documents): ${rejection.reason ?? "unknown reason"}`,
      );
      this.report = { documentSet: "stale", rejectedAt, reason: rejection.reason, warnings: [] };
      return;
    }

    const byName = new Map<string, FabricDocument>();
    for (const doc of documents) byName.set(documentKey(doc), doc);

    // The snapshot is the atomicity unit: built fully, then a single swap.
    this.snapshot = { documents, byName, generation: this.snapshot.generation + 1 };
    this.report = { documentSet: "current", warnings: [] };
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

/** Was the recursive watch rejected for the platform (not our path being bad)? */
function isRecursiveUnavailable(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM"
  );
}

/**
 * Open a store on `dir`: performs the initial reload (last-good / empty-on-
 * reject semantics apply to this cold start too) and begins watching with
 * debounced reloads.
 */
export function start(dir: string): RegistryStore {
  return new RegistryStore(dir);
}
