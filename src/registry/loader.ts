// Document loader: synchronous walk of a documents directory, YAML parse,
// envelope validation, and inert marking. One document per file; one pass;
// no caching (the store in Task 5 owns reload/watch semantics).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  API_VERSION,
  KINDS,
  isRecord,
  type FabricDocument,
  type Kind,
  type Route,
} from "./document.js";

export type LoadProblem = { path: string; reason: string };

export type LoadResult = { documents: FabricDocument[]; problems: LoadProblem[] };

// Layout: the canonical layout is nested `documents/<Kind>/<name>.yaml` —
// one directory per kind, one file per document (the plan's stated layout).
// Flat `documents/<file>.yaml` is also accepted as a convenience for a
// single-kind store: a top-level file's kind comes from its `kind` field,
// so a flat file loads regardless of directory. Any other subdirectory
// name (or nested deeper directory) is foreign — skipped with a problem.
//
// Kinds registered with a kind-runner in T1: Workspace only. Other kinds
// parse as documents but load inert (core §10.2 / T1 scope).

/** Kinds with a registered kind-runner in T1 (Workspace only). */
const REGISTERED_KIND_RUNNERS: ReadonlySet<Kind> = new Set<Kind>(["Workspace"]);

/** Kinds with kind-required fields in T1 (Workspace only). */
const KIND_REQUIRED_FIELDS: { Workspace: readonly (readonly string[])[] } = {
  Workspace: [["storage", "fingerprint"]],
};

export function loadDirectory(dir: string): LoadResult {
  const documents: FabricDocument[] = [];
  const problems: LoadProblem[] = [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    return { documents, problems: [{ path: dir, reason: `documents directory unreadable: ${String(err)}` }] };
  }

  for (const entry of entries) {
    const path = join(dir, entry);
    const stats = safeStat(path, problems);
    if (stats === null) continue;

    if (stats.isDirectory()) {
      // Nested-kind directory: only documents/<Kind>/ is canonical; anything
      // else is a foreign subdirectory → skipped with a problem.
      if (KINDS.includes(entry as Kind)) {
        loadKindDir(path, entry as Kind, documents, problems);
      } else {
        problems.push({ path, reason: "foreign subdirectory skipped (expected documents/<Kind>/<name>.yaml)" });
      }
      continue;
    }

    // Top-level files: flat single-kind convenience files; non-.yaml skipped.
    if (!entry.endsWith(".yaml")) {
      problems.push({ path, reason: "non-YAML file skipped" });
      continue;
    }
    loadFile(path, documents, problems);
  }

  return { documents, problems };
}

function loadKindDir(dir: string, _kind: Kind, documents: FabricDocument[], problems: LoadProblem[]): void {
  // Same contract as the top-level guard: an unreadable kind directory is
  // a LoadProblem, never a throw out of reload().
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    problems.push({ path: dir, reason: `kind directory unreadable: ${String(err)}` });
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    const stats = safeStat(path, problems);
    if (stats === null) continue;
    if (stats.isDirectory()) {
      // Deeper nesting is not part of the layout (kind dirs are flat).
      problems.push({ path, reason: "unexpected subdirectory under documents/<Kind>/ skipped" });
      continue;
    }
    if (!entry.endsWith(".yaml")) {
      problems.push({ path, reason: "non-YAML file skipped" });
      continue;
    }
    loadFile(path, documents, problems);
  }
}

// stat() that tolerates a file vanishing between readdir and stat (a
// deletion race under Task 5's watcher) — the entry becomes a problem
// instead of crashing the whole load.
function safeStat(path: string, problems: LoadProblem[]): import("node:fs").Stats | null {
  try {
    return statSync(path);
  } catch (err) {
    problems.push({ path, reason: `entry vanished mid-walk: ${String(err)}` });
    return null;
  }
}

function loadFile(path: string, documents: FabricDocument[], problems: LoadProblem[]): void {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (err) {
    problems.push({ path, reason: `YAML parse error: ${String(err)}` });
    return;
  }
  if (!isRecord(raw)) {
    problems.push({ path, reason: "document is a non-object (expected a YAML mapping)" });
    return;
  }

  documents.push(buildDocument(raw, path));
}

function buildDocument(raw: Record<string, unknown>, path: string): FabricDocument {
  const inertReasons: string[] = [];

  // Envelope shape (core §3): metadata, spec; status is reader-ignored.
  const metadata = isRecord(raw["metadata"]) ? (raw["metadata"] as Record<string, unknown>) : {};
  const spec = isRecord(raw["spec"]) ? (raw["spec"] as Record<string, unknown>) : {};

  const apiVersion = typeof raw["apiVersion"] === "string" ? (raw["apiVersion"] as string) : "";
  const rawKind = raw["kind"];
  const kind: Kind | undefined = KINDS.includes(rawKind as Kind) ? (rawKind as Kind) : undefined;
  const name = typeof metadata["name"] === "string" ? (metadata["name"] as string) : "";
  const labels = isRecord(metadata["labels"]) ? toStringMap(metadata["labels"]) : {};
  const owner = typeof spec["owner"] === "string" ? (spec["owner"] as string) : "";
  const routes = Array.isArray(spec["routes"])
    ? (spec["routes"] as unknown[]).filter((r): r is Route => isRecord(r) && typeof r["type"] === "string")
    : [];
  const kindSpec = kind !== undefined && isRecord(spec[kind.toLowerCase()]) ? (spec[kind.toLowerCase()] as Record<string, unknown>) : {};
  const parent = isRecord(spec["parent"]) ? readParent(spec["parent"]) : undefined;

  // Inert-marking (never a load rejection for well-formed YAML):
  if (kind === undefined) {
    inertReasons.push(rawKind === undefined ? "missing kind" : `unknown kind: ${String(rawKind)}`);
  }
  if (raw["apiVersion"] !== API_VERSION) {
    inertReasons.push(`wrong apiVersion: ${JSON.stringify(apiVersion)} (expected ${API_VERSION})`);
  }
  if (owner === "") {
    inertReasons.push("missing spec.owner");
  }
  if (name === "") {
    inertReasons.push("missing metadata.name");
  }
  // T1 registers a kind-runner for Workspace only (core §10.2; other kinds
  // are schema-reserved and inert in T1).
  if (kind === undefined || !REGISTERED_KIND_RUNNERS.has(kind)) {
    inertReasons.push(
      kind === undefined
        ? "no kind-runner for unknown kind"
        : `no kind-runner registered for kind ${kind} in T1`,
    );
  } else {
    const required = kind === "Workspace" ? KIND_REQUIRED_FIELDS.Workspace : [];
    for (const field of required) {
      if (readPath(kindSpec, field) === undefined) {
        inertReasons.push(`missing kind-required field spec.${kind.toLowerCase()}.${field.join(".")}`);
      }
    }
  }

  const doc: FabricDocument = {
    apiVersion,
    // Unknown kinds stay in the document set (inert) — the Kind union can't
    // express them, so the raw string is carried in the pinned `kind` field.
    kind: kind ?? (typeof rawKind === "string" ? (rawKind as Kind) : ("Unknown" as Kind)),
    name,
    labels,
    owner,
    routes,
    kindSpec,
    parent,
    resolvable: inertReasons.length === 0,
    inertReasons,
    sourcePath: path,
    raw,
  };
  return doc;
}

function toStringMap(value: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function readParent(value: Record<string, unknown>): { kind: string; name: string } | undefined {
  const kind = typeof value["kind"] === "string" ? (value["kind"] as string) : undefined;
  const name = typeof value["name"] === "string" ? (value["name"] as string) : undefined;
  if (kind === undefined || name === undefined) return undefined;
  return { kind, name };
}

function readPath(obj: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = obj;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}
