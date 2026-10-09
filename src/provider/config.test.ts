// loadProviderConfig tests — the provider config file loader (the `twill
// provider --config <file>` input). Fail-loud on every malformed shape,
// naming the field; a valid block parses with routes verbatim.

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { loadProviderConfig, ConfigError } from "./config.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Write `text` to a temp config file; return its path. */
function configFile(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "twill-provider-config-"));
  dirs.push(dir);
  const path = join(dir, "provider.yaml");
  writeFileSync(path, text);
  return path;
}

const VALID = `registry: http://localhost:8080
parents: [ws-main]
routes:
  - { type: local, path: /srv/ws }
`;

describe("loadProviderConfig", () => {
  it("parses a valid config; routes pass through verbatim (unknown keys preserved)", () => {
    const route = { type: "local", path: "/srv/ws", futureKey: { nested: [1, 2] } };
    const path = configFile(
      `registry: http://localhost:8080\nparents: [ws-main, ws-two]\nroutes:\n  - ${JSON.stringify(route)}\npollIntervalMs: 250\n`,
    );
    const config = loadProviderConfig(path);
    expect(config.registry).toBe("http://localhost:8080");
    expect(config.parents).toEqual(["ws-main", "ws-two"]);
    expect(config.routes[0]).toEqual(route); // verbatim
    expect(config.pollIntervalMs).toBe(250);
  });

  it("omits pollIntervalMs when absent", () => {
    const config = loadProviderConfig(configFile(VALID));
    expect("pollIntervalMs" in config).toBe(false);
  });

  it("accepts JSON (a YAML subset)", () => {
    const path = configFile(
      JSON.stringify({ registry: "http://x:1", parents: ["p"], routes: [{ type: "local" }] }),
    );
    expect(loadProviderConfig(path).registry).toBe("http://x:1");
  });

  it("throws ConfigError on an unreadable file", () => {
    expect(() => loadProviderConfig(join(tmpdir(), "twill-definitely-absent.yaml"))).toThrow(ConfigError);
    expect(() => loadProviderConfig(join(tmpdir(), "twill-definitely-absent.yaml"))).toThrow(/cannot read/);
  });

  it("throws on invalid YAML", () => {
    expect(() => loadProviderConfig(configFile("registry: [unclosed"))).toThrow(/not valid YAML/);
  });

  it("throws on a non-mapping document", () => {
    expect(() => loadProviderConfig(configFile("- just\n- a\n- list\n"))).toThrow(/must be a mapping/);
  });

  it("throws when registry is missing or empty", () => {
    expect(() => loadProviderConfig(configFile("parents: [p]\nroutes: [{type: local}]\n"))).toThrow(/requires `registry`/);
    expect(() => loadProviderConfig(configFile('registry: ""\nparents: [p]\nroutes: [{type: local}]\n'))).toThrow(
      /requires `registry`/,
    );
  });

  it("throws when routes is missing, empty, or has a route without a string type", () => {
    expect(() => loadProviderConfig(configFile("registry: http://x\nparents: [p]\n"))).toThrow(/requires `routes`/);
    expect(() => loadProviderConfig(configFile("registry: http://x\nparents: [p]\nroutes: []\n"))).toThrow(
      /requires `routes`/,
    );
    expect(() => loadProviderConfig(configFile("registry: http://x\nparents: [p]\nroutes: [{type: 5}]\n"))).toThrow(
      /requires `routes`/,
    );
  });

  it("throws when parents is missing, empty, or has a non-string", () => {
    expect(() => loadProviderConfig(configFile("registry: http://x\nroutes: [{type: local}]\n"))).toThrow(
      /requires `parents`/,
    );
    expect(() => loadProviderConfig(configFile("registry: http://x\nparents: []\nroutes: [{type: local}]\n"))).toThrow(
      /requires `parents`/,
    );
    expect(() => loadProviderConfig(configFile("registry: http://x\nparents: [5]\nroutes: [{type: local}]\n"))).toThrow(
      /requires `parents`/,
    );
  });

  it("throws when pollIntervalMs is not a positive number", () => {
    for (const bad of ["0", "-5", '"fast"']) {
      expect(() =>
        loadProviderConfig(configFile(`registry: http://x\nparents: [p]\nroutes: [{type: local}]\npollIntervalMs: ${bad}\n`)),
      ).toThrow(/pollIntervalMs` must be a positive number/);
    }
  });
});
