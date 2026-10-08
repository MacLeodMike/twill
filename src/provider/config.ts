// Provider config loading + event-log bridge (T2.5 Task 5) — the
// `twill provider --config <file>` subcommand's helpers. The subcommand
// itself lives in src/cli/twill.ts; this module exists because the CLI is
// deliberately dependency-free (it imports nothing from src/registry —
// the same HTTP contract any consumer would use), so the `yaml` parse and
// the ProviderConfig type it would need stay here in the provider library.
//
// The config file is the registry's own representation format: YAML
// (loader.ts, and the `yaml` package is already a dependency), with JSON
// accepted as its strict subset. Shape = ProviderConfig exactly:
//
//   registry: http://localhost:8080          # the /twill/v1alpha1 prefix is added when absent
//   pollIntervalMs: 2000                      # optional, default 5000
//   parents: [workstation-repos]              # parent workspace names polled
//   routes:                                   # verbatim route objects this provider owns
//     - match: { agentLocation: workstation }
//       type: local
//       path: ~/repos/workstation-repos
//       precondition:
//         steps:
//           - { type: gitClone, url: git@example:me/repo.git, ref: main }
//
// The field names are load-bearing: they are the ProviderConfig wire shape
// twill-pi will construct in-process when it embeds startProvider.

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { Route } from "../registry/document.js";
import type { ProviderConfig } from "./loop.js";

/** Any config error that is the operator's fault: message on stderr, exit 1. */
export class ConfigError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One route object: a non-array object with a string `type` (match/precondition/etc. ride along verbatim). */
function isRoute(value: unknown): value is Route {
  return isRecord(value) && typeof value["type"] === "string";
}

/**
 * Read + validate a provider config file (YAML, or JSON as its subset).
 * Throws ConfigError on any malformation — unreadable file, non-object
 * document, or a missing/mis-typed required field.
 */
export function loadProviderConfig(path: string): ProviderConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new ConfigError(`cannot read provider config ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (err) {
    throw new ConfigError(`provider config ${path} is not valid YAML: ${String(err)}`);
  }
  if (!isRecord(parsed)) {
    throw new ConfigError(`provider config ${path} must be a mapping (registry, routes, parents)`);
  }

  const registry = parsed["registry"];
  if (typeof registry !== "string" || registry === "") {
    throw new ConfigError("provider config requires `registry` (the registry base URL)");
  }

  const routes = parsed["routes"];
  if (!Array.isArray(routes) || routes.length === 0 || !routes.every(isRoute)) {
    throw new ConfigError("provider config requires `routes` (a non-empty list of route objects, each with a string type)");
  }

  const parents = parsed["parents"];
  if (
    !Array.isArray(parents) ||
    parents.length === 0 ||
    !parents.every((parent) => typeof parent === "string" && parent !== "")
  ) {
    throw new ConfigError("provider config requires `parents` (a non-empty list of parent workspace names)");
  }

  const pollIntervalMs = parsed["pollIntervalMs"];
  if (pollIntervalMs !== undefined && (typeof pollIntervalMs !== "number" || !(pollIntervalMs > 0))) {
    throw new ConfigError("provider config `pollIntervalMs` must be a positive number (milliseconds)");
  }

  return {
    registry,
    routes: routes as Route[],
    parents: parents as string[],
    ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
  };
}

export type { ProviderConfig };

/**
 * The default fulfillment log sink: `console.log`, one ISO-prefixed line
 * per event. ProviderEvent entries append to `data` — a future event
 * carries its payload without a signature change (loop.ts stamps exactly
 * {event, at} today).
 */
export const consoleSink = (line: string): void => console.log(line);
