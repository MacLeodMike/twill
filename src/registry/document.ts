// FabricDocument — the parsed envelope of a registry-side fabric object
// (core spec §3), produced by the document loader (loader.ts).
//
// `resolvable: false` (inert) marks a well-formed document with no
// resolvable behavior — it still appears in discovery; `inertReasons`
// records why it was marked inert (bad apiVersion, missing owner,
// unregistered kind-runner, missing kind-required field).

/** The six protocol-fixed kinds (core §10.2). */
export type Kind = "Workspace" | "Card" | "Claim" | "MCPServer" | "Skill" | "AgentProfile";

export const KINDS: readonly Kind[] = ["Workspace", "Card", "Claim", "MCPServer", "Skill", "AgentProfile"];

export const API_VERSION = "twill.bitwiseoperations.ca/v1alpha1";

/**
 * Route envelope (core §6.1) — protocol-fixed keys plus kind-owned static
 * fields (e.g. Workspace `path`, `address`). Kept loose (Record) here;
 * consumers read the kind vocabulary themselves.
 */
export type Route = Record<string, unknown> & { match?: Record<string, string>; type: string };

export type ParentRef = { kind: string; name: string };

export type FabricDocument = {
  apiVersion: string;
  kind: Kind;
  name: string;
  labels: Record<string, string>;
  owner: string;
  routes: Route[];
  /** `spec.<lowercase kind>` — the kind's spec object, verbatim. */
  kindSpec: Record<string, unknown>;
  parent?: { kind: string; name: string };
  resolvable: boolean;
  /** Why `resolvable` is false, when it is. Empty when resolvable. */
  inertReasons: string[];
  sourcePath: string;
  /** The parsed YAML document, unmodified. */
  raw: unknown;
};

/** True when the loader accepts `raw` as an envelope-shaped object at all. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Durable id (core §4.3): storage-backed kinds → `spec.<kindname>.storage.id`
 * (Workspace in v1alpha1); all others → `spec.<kindname>.id`. Missing → null.
 * Computed even for inert documents (§10.3 discovery carries `durable_id`
 * for every listed document, inert included).
 */
export function durableIdOf(doc: FabricDocument): string | null {
  const id = kindField(doc, doc.kind === "Workspace" ? ["storage", "id"] : ["id"]);
  return typeof id === "string" && id !== "" ? id : null;
}

/** Read a field from `spec.<lowercase kind>` (the kind's spec object). */
export function kindField(doc: FabricDocument, path: readonly string[]): unknown {
  let current: unknown = doc.kindSpec;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}
