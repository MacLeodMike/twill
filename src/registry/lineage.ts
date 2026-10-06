// Lineage computation + the §8.3 load-reject rule (core spec §4.2, §4.3,
// §8.3). Consumed by the store (Task 5), which calls `rejectCheck` on every
// (re)load: a rejected set means serve the last-good set / the empty
// registry and report `documentSet: stale` with the reason.

import { durableIdOf, isRecord, type FabricDocument } from "./document.js";

/** The `"<Kind>/<name>"` key documents are referenced by in maps. */
export function documentKey(doc: FabricDocument): string {
  return `${doc.kind}/${doc.name}`;
}

/**
 * Self-inclusive ancestor set (§8.3): the document's own `"<Kind>/<name>"`
 * key plus every transitive `spec.parent` key. Parent keys are included
 * whether or not the parent is present in `byName` — presence is decided by
 * the caller (the reject rule), not by the walk. `spec.parent.kind` is
 * matched case-sensitively against the loaded kinds.
 */
export function ancestorSet(doc: FabricDocument, byName: Map<string, FabricDocument>): Set<string> {
  const ancestors = new Set<string>();
  ancestors.add(documentKey(doc));
  let current: FabricDocument | undefined = doc;
  while (current?.parent !== undefined) {
    const parentKey = `${current.parent.kind}/${current.parent.name}`;
    if (ancestors.has(parentKey)) break; // cycle: stop, caller decides
    ancestors.add(parentKey);
    current = byName.get(parentKey);
  }
  return ancestors;
}

export type RejectResult = { rejected: boolean; reason?: string };

/**
 * The §8.3 rule over the whole document set. Order: cycles first (§4.2 —
 * cycle rejection precedes lineage computation), then duplicate durable ids
 * (always rejected, any kinds), then the fingerprint-collision-without-
 * lineage rule over storage-backed documents.
 */
export function rejectCheck(documents: FabricDocument[]): RejectResult {
  const byName = new Map<string, FabricDocument>();
  for (const doc of documents) {
    const key = documentKey(doc);
    if (!byName.has(key)) byName.set(key, doc); // first occurrence kept
  }

  // §4.2: cycles reject the set before any lineage arithmetic.
  const cycle = findCycle(documents, byName);
  if (cycle !== null) {
    return { rejected: true, reason: `spec.parent cycle: ${cycle.join(" -> ")}` };
  }

  // §8.3: duplicate durable id — always rejected regardless of fingerprint
  // or lineage. Documents with no durable id (null) are exempt.
  const byDurableId = new Map<string, FabricDocument>();
  for (const doc of documents) {
    const durableId = durableIdOf(doc);
    if (durableId === null) continue;
    const first = byDurableId.get(durableId);
    if (first !== undefined) {
      return {
        rejected: true,
        reason: `duplicate durable id ${durableId}: ${documentKey(first)} and ${documentKey(doc)}`,
      };
    }
    byDurableId.set(durableId, doc);
  }

  // §8.3: fingerprint collision without lineage. Only storage-backed
  // documents with a populated `storage.fingerprint` participate (Workspace
  // in v1alpha1). Within an equal-fingerprint group, every pair must share
  // an ancestor that is itself loaded in the set.
  const byFingerprint = new Map<string, FabricDocument[]>();
  for (const doc of documents) {
    if (doc.kind !== "Workspace") continue;
    const fingerprint = fingerprintOf(doc);
    if (fingerprint === null) continue;
    const group = byFingerprint.get(fingerprint);
    if (group === undefined) byFingerprint.set(fingerprint, [doc]);
    else group.push(doc);
  }

  for (const [fingerprint, group] of byFingerprint) {
    if (group.length < 2) continue;
    // Group members with equal fingerprints but duplicate storage ids are
    // already covered by the durable-id check above; the remaining pairs
    // all differ on durable id, so the lineage rule applies directly.
    const ancestorSets = group.map((doc) => {
      const present = new Set([...ancestorSet(doc, byName)].filter((key) => byName.has(key)));
      return { doc, present };
    });
    for (let i = 0; i < ancestorSets.length; i++) {
      for (let j = i + 1; j < ancestorSets.length; j++) {
        const a = ancestorSets[i]!;
        const b = ancestorSets[j]!;
        if (intersects(a.present, b.present)) continue;
        return {
          rejected: true,
          reason:
            `fingerprint collision without lineage: ${documentKey(a.doc)} and ${documentKey(b.doc)} ` +
            `share storage.fingerprint ${fingerprint} with different storage.ids ` +
            `and no common ancestor present in the document set`,
        };
      }
    }
  }

  return { rejected: false };
}

/** A populated, non-empty `spec.<kindname>.storage.fingerprint`, else null. */
function fingerprintOf(doc: FabricDocument): string | null {
  const storage = doc.kindSpec["storage"];
  if (!isRecord(storage)) return null;
  const fingerprint = storage["fingerprint"];
  return typeof fingerprint === "string" && fingerprint !== "" ? fingerprint : null;
}

/**
 * First `spec.parent` cycle found in the set, as the walked key sequence
 * (e.g. ["Workspace/alpha", "Workspace/beta", "Workspace/alpha"]), or null.
 */
function findCycle(documents: FabricDocument[], byName: Map<string, FabricDocument>): string[] | null {
  for (const doc of documents) {
    const walked: string[] = [documentKey(doc)];
    let current: FabricDocument | undefined = doc;
    while (current?.parent !== undefined) {
      const parentKey = `${current.parent.kind}/${current.parent.name}`;
      if (walked.includes(parentKey)) return [...walked, parentKey];
      walked.push(parentKey);
      current = byName.get(parentKey);
    }
  }
  return null;
}

function intersects(a: Set<string>, b: Set<string>): boolean {
  for (const key of a) {
    if (b.has(key)) return true;
  }
  return false;
}
