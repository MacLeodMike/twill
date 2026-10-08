// The `twill` CLI (Task 7) — the registry HTTP surface's first consumer.
//
// Commands, hand-rolled arg parse (no dependency), fetch against the
// registry base URL (flag --registry, env TWILL_REGISTRY, default
// http://localhost:8080/twill/v1alpha1):
//
//   twill resolve <kind> <name> --principal P [--agent-location L] [--agent-kind K]
//   twill list
//   twill get <kind> <name>
//   twill health
//   twill claim create <parentKind> <parentName> --principal P --route '<json>'
//        [--param k=v]... [--name <claimName>]
//   twill claim release <parentKind> <parentName> <claimName>
//   twill claims <parentKind> <parentName>
//   twill provider --config <file>
//
// provider runs the localhost provider loop (T2.5) as a standalone
// long-running process: it reads the provider config file (YAML; JSON is
// its strict subset — the registry's own representation format), boots
// startProvider (the SAME embeddable entry point twill-pi uses), logs one
// line per lifecycle event (claim fulfilled / failed / ignored / skipped)
// to stdout, and runs until SIGINT (graceful: polling stops, in-flight
// fulfillments settle). Exit codes: 0 on a SIGINT stop, 1 on config or
// usage error.
//
// Output pins: resolve prints the Attached descriptor as pretty JSON
// (NoMatch/Unreachable print the word plainly); get/health print the
// response body as pretty JSON; claim create/release print the claim
// envelope as pretty JSON; list/claims print tables. Exit codes: Attached
// 0, NoMatch 2, Unreachable 3; claim create/release/list 0 on success, 1
// on HTTP (4xx included — the error body prints) /transport/usage error.
//
// The CLI deliberately imports nothing from src/registry — it exercises
// the same HTTP contract any consumer would.

const DEFAULT_REGISTRY = "http://localhost:8080/twill/v1alpha1";
const DEFAULT_AGENT_LOCATION = "workstation";
const DEFAULT_AGENT_KIND = "twill-cli/0.1.0";

const COMMANDS = ["resolve", "list", "get", "health", "claim", "claims", "provider"] as const;
type Command = (typeof COMMANDS)[number];

const FLAG_NAMES = [
  "--registry",
  "--agent-location",
  "--agent-kind",
  "--principal",
  "--route",
  "--param",
  "--name",
  "--config",
] as const;

type Parsed = {
  command: Command;
  positional: string[];
  registry: string;
  agentLocation: string;
  agentKind: string;
  principal: string | undefined;
  route: string | undefined;
  /** Repeated --param k=v occurrences, in argv order. */
  params: string[];
  name: string | undefined;
  config: string | undefined;
};

/** Any invocation error that is the caller's fault: message on stderr, exit 1. */
class UsageError extends Error {}

const USAGE = `usage:
  twill resolve <kind> <name> --principal <p> [--agent-location <l>] [--agent-kind <k>]
  twill list
  twill get <kind> <name>
  twill health
  twill claim create <parentKind> <parentName> --principal <p> --route '<json>' [--param k=v]... [--name <n>]
  twill claim release <parentKind> <parentName> <claimName>
  twill claims <parentKind> <parentName>
  twill provider --config <file>
flags: --registry <url> (env TWILL_REGISTRY, default ${DEFAULT_REGISTRY})`;

/** Parse argv (post-node, post-script). Throws UsageError on any malformation. */
function parseArgs(argv: string[], env: NodeJS.ProcessEnv): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  const params: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const name = eq === -1 ? token : token.slice(0, eq);
      if (!(FLAG_NAMES as readonly string[]).includes(name)) {
        throw new UsageError(`unknown flag: ${name}`);
      }
      const value = eq === -1 ? argv[++i] : token.slice(eq + 1);
      if (value === undefined) throw new UsageError(`flag ${name} requires a value`);
      if (name === "--param") {
        // Repeatable: every occurrence becomes one parameters entry.
        params.push(value);
      } else {
        flags.set(name, value);
      }
    } else {
      positional.push(token);
    }
  }

  const command = positional.shift();
  if (command === undefined || !(COMMANDS as readonly string[]).includes(command)) {
    throw new UsageError(command === undefined ? "no command given" : `unknown command: ${command}`);
  }

  const registry = (flags.get("--registry") ?? env["TWILL_REGISTRY"] ?? DEFAULT_REGISTRY).replace(/\/+$/, "");
  return {
    command: command as Command,
    positional,
    registry,
    agentLocation: flags.get("--agent-location") ?? DEFAULT_AGENT_LOCATION,
    agentKind: flags.get("--agent-kind") ?? DEFAULT_AGENT_KIND,
    principal: flags.get("--principal"),
    route: flags.get("--route"),
    params,
    name: flags.get("--name"),
    config: flags.get("--config"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a response body as JSON; undefined when the body isn't JSON. */
async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Report a non-2xx registry answer; returns the HTTP-error exit code. */
function httpError(status: number, body: unknown): number {
  const detail =
    isRecord(body) && typeof body["error"] === "string"
      ? body["error"]
      : body === undefined
        ? "(no body)"
        : JSON.stringify(body);
  console.error(`twill: registry answered HTTP ${status}: ${detail}`);
  return 1;
}

/** Positional arity check for the two-argument commands. */
function requireKindName(p: Parsed): { kind: string; name: string } {
  const [kind, name] = p.positional;
  if (kind === undefined || name === undefined || p.positional.length !== 2) {
    throw new UsageError(`${p.command} requires exactly <kind> and <name>`);
  }
  return { kind, name };
}

async function cmdResolve(p: Parsed): Promise<number> {
  const { kind, name } = requireKindName(p);
  if (p.principal === undefined) {
    throw new UsageError("resolve requires --principal <principal> (e.g. user:you)");
  }
  const res = await fetch(`${p.registry}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind,
      name,
      consumer: { agentLocation: p.agentLocation, agentKind: p.agentKind, principal: p.principal },
    }),
  });
  const body = await readJson(res);
  if (!res.ok) return httpError(res.status, body);

  if (!isRecord(body)) {
    console.error(`twill: unexpected resolve response: ${JSON.stringify(body)}`);
    return 1;
  }
  switch (body["result"]) {
    case "Attached":
      console.log(JSON.stringify(body["descriptor"] ?? null, null, 2));
      return 0;
    case "NoMatch":
      console.log("NoMatch");
      return 2;
    case "Unreachable": {
      console.log("Unreachable");
      if (body["errors"] !== undefined) console.error(JSON.stringify(body["errors"], null, 2));
      return 3;
    }
    default:
      console.error(`twill: unexpected resolve response: ${JSON.stringify(body)}`);
      return 1;
  }
}

async function cmdList(p: Parsed): Promise<number> {
  const res = await fetch(`${p.registry}/`);
  const body = await readJson(res);
  if (!res.ok) return httpError(res.status, body);
  if (!Array.isArray(body)) {
    console.error(`twill: unexpected discovery response: ${JSON.stringify(body)}`);
    return 1;
  }
  printTable(body as Array<Record<string, unknown>>, ["kind", "name", "resolvable", "durable_id"]);
  return 0;
}

async function cmdGet(p: Parsed): Promise<number> {
  const { kind, name } = requireKindName(p);
  const res = await fetch(`${p.registry}/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`);
  const body = await readJson(res);
  if (!res.ok) return httpError(res.status, body);
  console.log(JSON.stringify(body, null, 2));
  return 0;
}

async function cmdHealth(p: Parsed): Promise<number> {
  const res = await fetch(`${p.registry}/health`);
  const body = await readJson(res);
  if (!res.ok) return httpError(res.status, body);
  console.log(JSON.stringify(body, null, 2));
  return 0;
}

/** GET one document envelope; undefined when the registry 404s it. Throws on other failures. */
async function fetchDocument(p: Parsed, kind: string, name: string): Promise<Record<string, unknown> | undefined> {
  const res = await fetch(`${p.registry}/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`);
  const body = await readJson(res);
  if (res.status === 404) return undefined;
  if (!res.ok || !isRecord(body)) {
    throw new Error(`cannot read ${kind}/${name} from the registry (HTTP ${res.status})`);
  }
  return body;
}

/** Every claim envelope against the parent; includeReleased opts in the released ones. */
async function fetchClaims(
  p: Parsed,
  parentKind: string,
  parentName: string,
  opts: { includeReleased: boolean },
): Promise<Array<Record<string, unknown>>> {
  const parent = `${encodeURIComponent(parentKind)}/${encodeURIComponent(parentName)}`;
  const suffix = opts.includeReleased ? "&includeReleased=true" : "";
  const res = await fetch(`${p.registry}/claims?parent=${parent}${suffix}`);
  const body = await readJson(res);
  if (!res.ok) {
    throw new Error(
      `registry answered HTTP ${res.status}: ${isRecord(body) && typeof body["error"] === "string" ? body["error"] : JSON.stringify(body)}`,
    );
  }
  if (!Array.isArray(body)) {
    throw new Error(`unexpected claims response: ${JSON.stringify(body)}`);
  }
  return body as Array<Record<string, unknown>>;
}

/** POST/PATCH a claim envelope; prints the registry's error body on failure. */
async function writeClaim(
  p: Parsed,
  method: "POST" | "PATCH",
  claimName: string,
  doc: Record<string, unknown>,
): Promise<number> {
  const res = await fetch(`${p.registry}/Claim/${encodeURIComponent(claimName)}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(doc),
  });
  const body = await readJson(res);
  if (!res.ok) return httpError(res.status, body);
  console.log(JSON.stringify(body, null, 2));
  return 0;
}

/** Sanitize one name component: lowercase, [^a-z0-9-] collapsed to '-', edge dashes trimmed. */
function sanitizeNamePart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** --param k=v occurrences as the claim's parameters object (last wins per key). */
function parseParams(params: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const param of params) {
    const eq = param.indexOf("=");
    if (eq <= 0) throw new UsageError(`--param must be k=v with a non-empty key (got '${param}')`);
    out[param.slice(0, eq)] = param.slice(eq + 1);
  }
  return out;
}

/** Parse --route as a JSON object (the verbatim resolved route, core §9). */
function parseRoute(raw: string): Record<string, unknown> {
  let route: unknown;
  try {
    route = JSON.parse(raw);
  } catch (err) {
    throw new UsageError(`--route must be a JSON object: ${String(err)}`);
  }
  if (!isRecord(route)) {
    throw new UsageError("--route must be a JSON object (the verbatim resolved route, e.g. '{\"type\":\"local\"}')");
  }
  return route;
}

/** claimedOn (§8.4): the parent's durable id; fingerprint only when the parent is a Workspace. */
function claimedOnOf(parent: Record<string, unknown>, kind: string, name: string): Record<string, unknown> {
  if (!isRecord(parent["spec"]) || !isRecord(parent["spec"][kind.toLowerCase()])) {
    throw new Error(`parent ${kind}/${name} carries no spec.${kind.toLowerCase()} section (not a well-formed ${kind})`);
  }
  const kindSpec = parent["spec"][kind.toLowerCase()] as Record<string, unknown>;
  const durableId =
    kind === "Workspace" && isRecord(kindSpec["storage"]) ? kindSpec["storage"]["id"] : kindSpec["id"];
  if (typeof durableId !== "string" || durableId === "") {
    throw new Error(`parent ${kind}/${name} has no durable id (spec.${kind.toLowerCase()}.id / .storage.id)`);
  }
  if (kind === "Workspace") {
    const fingerprint = isRecord(kindSpec["storage"]) ? kindSpec["storage"]["fingerprint"] : undefined;
    return { fingerprint, durable_id: durableId };
  }
  return { durable_id: durableId };
}

async function cmdClaim(p: Parsed): Promise<number> {
  const subcommand = p.positional.shift();
  switch (subcommand) {
    case "create":
      return await cmdClaimCreate(p);
    case "release":
      return await cmdClaimRelease(p);
    default:
      throw new UsageError(
        subcommand === undefined
          ? "claim requires a subcommand (create | release)"
          : `unknown claim subcommand: ${subcommand} (create | release)`,
      );
  }
}

/**
 * claim create: fetch the parent to compute claimedOn (the CLI constructs
 * the full claim document — claimedOn consistency against the parent is
 * enforced registry-side, §8.4), mint name/id, POST.
 */
async function cmdClaimCreate(p: Parsed): Promise<number> {
  const [parentKind, parentName] = p.positional;
  if (parentKind === undefined || parentName === undefined || p.positional.length !== 2) {
    throw new UsageError("claim create requires exactly <parentKind> and <parentName>");
  }
  if (p.principal === undefined) {
    throw new UsageError("claim create requires --principal <principal> (e.g. user:you)");
  }
  if (p.route === undefined) {
    throw new UsageError("claim create requires --route '<json>' (the verbatim resolved route)");
  }
  const route = parseRoute(p.route);
  const parameters = parseParams(p.params);

  const parent = await fetchDocument(p, parentKind, parentName);
  if (parent === undefined) {
    console.error(`twill: no such parent: ${parentKind}/${parentName}`);
    return 1;
  }
  const claimedOn = claimedOnOf(parent, parentKind, parentName);

  const epoch = Math.floor(Date.now() / 1000);
  const claimName =
    p.name ?? `claim-${sanitizeNamePart(parentName)}-${sanitizeNamePart(p.principal)}-${epoch}`;

  const doc: Record<string, unknown> = {
    apiVersion: "twill.bitwiseoperations.ca/v1alpha1",
    kind: "Claim",
    metadata: { name: claimName },
    spec: {
      owner: p.principal,
      routes: [],
      claim: {
        storageBacked: false,
        id: `cl_${epoch}`,
        principal: p.principal,
        route,
        parameters,
        claimedOn,
        released: false,
      },
      parent: { kind: parentKind, name: parentName },
    },
    status: {},
  };
  return await writeClaim(p, "POST", claimName, doc);
}

/**
 * claim release: v1alpha1 has no single-claim read endpoint (GET
 * /Claim/<name> is 501), so the stored envelope comes from the
 * parent-scoped read path; the PATCH sends it back with only
 * spec.claim.released flipped true (release is the only permitted
 * mutation — workspace §8's claim collision rule).
 */
async function cmdClaimRelease(p: Parsed): Promise<number> {
  const [parentKind, parentName, claimName] = p.positional;
  if (parentKind === undefined || parentName === undefined || claimName === undefined || p.positional.length !== 3) {
    throw new UsageError("claim release requires exactly <parentKind> <parentName> <claimName>");
  }
  const claims = await fetchClaims(p, parentKind, parentName, { includeReleased: true });
  const stored = claims.find(
    (claim) => isRecord(claim["metadata"]) && claim["metadata"]["name"] === claimName,
  );
  if (stored === undefined) {
    console.error(`twill: no such claim: Claim/${claimName} against ${parentKind}/${parentName}`);
    return 1;
  }
  const released: Record<string, unknown> = JSON.parse(JSON.stringify(stored)) as Record<string, unknown>;
  const spec = isRecord(released["spec"]) ? released["spec"] : undefined;
  const claim = spec !== undefined && isRecord(spec["claim"]) ? spec["claim"] : undefined;
  if (spec === undefined || claim === undefined) {
    console.error(`twill: stored claim ${claimName} carries no spec.claim (not a well-formed claim envelope)`);
    return 1;
  }
  claim["released"] = true;
  return await writeClaim(p, "PATCH", claimName, released);
}

/** claims: the un-released claims against one parent as a table. */
async function cmdClaims(p: Parsed): Promise<number> {
  const { kind: parentKind, name: parentName } = requireKindName(p);
  const claims = await fetchClaims(p, parentKind, parentName, { includeReleased: false });
  const rows = claims.map((claim) => {
    const metadata = isRecord(claim["metadata"]) ? claim["metadata"] : {};
    const spec = isRecord(claim["spec"]) ? claim["spec"] : {};
    const claimSpec = isRecord(spec["claim"]) ? spec["claim"] : {};
    const claimedOn = isRecord(claimSpec["claimedOn"]) ? claimSpec["claimedOn"] : {};
    return {
      name: metadata["name"] ?? "",
      principal: claimSpec["principal"] ?? "",
      durable_id: claimedOn["durable_id"] ?? "",
    };
  });
  printTable(rows, ["name", "principal", "durable_id"]);
  return 0;
}

/** A padded table: header line, one line per row, columns read by key. */
function printTable(rows: Array<Record<string, unknown>>, columns: readonly string[]): void {
  const cell = (row: Record<string, unknown>, column: string): string => String(row[column] ?? "");
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => cell(r, c).length)));
  const line = (values: string[]): string =>
    values.map((v, i) => v.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  console.log(line([...columns]));
  for (const row of rows) console.log(line(columns.map((c) => cell(row, c))));
}

/**
 * provider (T2.5 Task 5): the localhost provider loop as a standalone
 * long-running process — the shape an in-cluster deployment uses later
 * (provider spec §2). A thin wrapper over the embeddable entry point: the
 * config file IS the ProviderConfig wire shape, startProvider is the SAME
 * function twill-pi embeds in-process, and the loop's onEvent lines go to
 * stdout ("logs fulfillments").
 *
 * Long-running: this function never returns — the process stays alive on
 * the provider's poll timer until SIGINT (graceful: stop() ends polling,
 * in-flight fulfillments settle, exit 0). Config errors exit 1 via
 * UsageError (the operator's fault, same class as a malformed flag).
 */
async function cmdProvider(p: Parsed): Promise<number> {
  if (p.config === undefined) {
    throw new UsageError("provider requires --config <file> (the provider config: registry, routes, parents)");
  }
  // Lazy import: the CLI's other commands stay dependency-free (the
  // provider library carries the yaml parse + ProviderConfig type the
  // dependency-free CLI must not import statically).
  const { loadProviderConfig, consoleSink } = await import("../provider/config.js");
  const { startProvider } = await import("../provider/loop.js");
  let config: ReturnType<typeof loadProviderConfig>;
  try {
    config = loadProviderConfig(p.config);
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const provider = startProvider({ ...config, onEvent: consoleSink });
  console.log(
    `twill: provider serving ${config.parents.length} parent(s), ${config.routes.length} route(s) against ${config.registry} — ctrl-c to stop`,
  );
  process.on("SIGINT", () => {
    provider.stop();
    console.error("twill: SIGINT — provider stopped");
  });
  return await new Promise<number>(() => {}); // alive on the poll timer until SIGINT
}

/** The whole invocation; returns the process exit code. */
async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseArgs(argv, env);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`${USAGE}\n\nerror: ${err.message}`);
      return 1;
    }
    throw err;
  }

  try {
    switch (parsed.command) {
      case "resolve":
        return await cmdResolve(parsed);
      case "list":
        return await cmdList(parsed);
      case "get":
        return await cmdGet(parsed);
      case "health":
        return await cmdHealth(parsed);
      case "claim":
        return await cmdClaim(parsed);
      case "claims":
        return await cmdClaims(parsed);
      case "provider":
        return await cmdProvider(parsed);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`${USAGE}\n\nerror: ${err.message}`);
      return 1;
    }
    // Transport failure (connection refused, DNS, ...) — the registry is
    // not answerable; that's an operational error, not a usage error.
    console.error(`twill: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

// Run only when executed directly (not under import) — same guard as the
// registry server entry.
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("src/cli/twill.ts") || process.argv[1].endsWith("src/cli/twill.js"));
if (isMain) {
  main(process.argv.slice(2), process.env).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(`twill: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}
