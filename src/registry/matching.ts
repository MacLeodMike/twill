// Matching (core §7.1): exact string equality on every key the route's
// `match` object specifies. No wildcards, no case folding. Non-matching
// routes are silently skipped — matching is not a health check.

export type Consumer = { agentLocation: string; agentKind: string; principal: string };

/**
 * §7.1: does `consumer` match this route's `match` selector?
 *
 * - omitted `match` (or omitted keys) match all consumers;
 * - empty string as a `match` value is a spec violation → never matches;
 * - an anonymous consumer (`principal: ""`) is not matchable — the
 *   sentinel means "no claim", so it matches only routes that don't
 *   list `principal` at all.
 */
export function matches(match: Record<string, string> | undefined, consumer: Consumer): boolean {
  if (match === undefined) return true;
  for (const [key, value] of Object.entries(match)) {
    if (value === "") return false; // §7.1: empty in match is a violation
    const consumerValue = consumerValueFor(key, consumer);
    if (consumerValue === undefined || consumerValue !== value) return false;
  }
  return true;
}

const KNOWN_CONSUMER_KEYS: ReadonlySet<string> = new Set(["agentLocation", "agentKind", "principal"]);

function consumerValueFor(key: string, consumer: Consumer): string | undefined {
  if (!KNOWN_CONSUMER_KEYS.has(key)) return undefined; // unknown match key matches nothing
  return consumer[key as "agentLocation" | "agentKind" | "principal"];
}
