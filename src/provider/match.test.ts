// Claim-route matching tests (T2.5 Task 3) — Review Focus #1: a claim
// whose route matches none of the provider's configured routes is IGNORED
// (no materialization, no statusReport). isMine is the pure deep-equal
// predicate the loop's client-side filter applies.

import { describe, it, expect } from "vitest";
import { isMine } from "./match.js";
import type { Route } from "../registry/document.js";

const route = (over: Record<string, unknown> = {}): Route => ({
  match: { agentLocation: "workstation" },
  type: "local",
  path: "~/repos/payments-repo",
  precondition: { steps: [{ type: "gitClone", url: "git@x", ref: "main" }] },
  ...over,
});

describe("isMine — deep-equal route binding", () => {
  it("matches an identical route object", () => {
    expect(isMine(route(), [route()])).toBe(true);
  });

  it("matches regardless of key order and precondition object identity", () => {
    const reordered: Route = {
      precondition: { steps: [{ ref: "main", type: "gitClone", url: "git@x" }] },
      path: "~/repos/payments-repo",
      type: "local",
      match: { agentLocation: "workstation" },
    };
    expect(isMine(reordered, [route()])).toBe(true);
  });

  it("does not match a route that differs in any field", () => {
    expect(isMine(route({ path: "~/repos/other" }), [route()])).toBe(false);
    expect(isMine(route({ type: "ssh" }), [route()])).toBe(false);
    expect(isMine(route({ match: { agentLocation: "cluster" } }), [route()])).toBe(false);
    // Nested difference (the precondition steps).
    expect(
      isMine(route({ precondition: { steps: [{ type: "gitClone", url: "git@x", ref: "dev" }] } }), [route()]),
    ).toBe(false);
  });

  it("does not match a route with an extra key", () => {
    expect(isMine(route({ extra: true }), [route()])).toBe(false);
    expect(isMine(route(), [route({ extra: true })])).toBe(false);
  });

  it("matches when ANY configured route deep-equals", () => {
    const other: Route = { type: "local", path: "/elsewhere" };
    expect(isMine(route(), [other, route()])).toBe(true);
  });

  it("matches nothing against an empty configuration", () => {
    expect(isMine(route(), [])).toBe(false);
  });

  it("a route without match/precondition only equals the same minimal shape", () => {
    const minimal: Route = { type: "local", path: "/p" };
    expect(isMine({ type: "local", path: "/p" }, [minimal])).toBe(true);
    expect(isMine({ type: "local", path: "/p", match: {} }, [minimal])).toBe(false);
  });
});
