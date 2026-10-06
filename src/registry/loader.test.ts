import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDirectory } from "./loader.js";
import { durableIdOf } from "./document.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, "../../fixtures/documents");

function tempDocuments(): string {
  return mkdtempSync(join(tmpdir(), "twill-loader-"));
}

function write(dir: string, rel: string, content: string): string {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** A minimal valid Workspace document (name and storage id parameterized). */
function workspaceYaml(name: string, storageId: string): string {
  return `apiVersion: twill.bitwiseoperations.ca/v1alpha1
kind: Workspace
metadata: { name: ${name} }
spec:
  owner: user:test
  routes:
    - match: {agentLocation: workstation}
      type: local
      path: ~/repos
  workspace:
    storageBacked: true
    storage: { id: ${storageId}, fingerprint: vol-test }
status: {}
`;
}

describe("loadDirectory", () => {
  it("loads all three fixture documents as resolvable with correct durable ids", () => {
    const { documents, problems } = loadDirectory(fixtures);
    expect(problems).toEqual([]);
    expect(documents).toHaveLength(3);
    expect(documents.map((d) => d.name).sort()).toEqual([
      "payments-repo",
      "payments-repo-feat-x",
      "workstation-repos",
    ]);

    for (const doc of documents) {
      expect(doc.resolvable).toBe(true);
      expect(doc.inertReasons).toEqual([]);
      expect(doc.owner).toBe("user:example");
      expect(doc.labels["twill/workspace-class"]).toBe("git");
    }

    const ws = documents.find((d) => d.name === "workstation-repos")!;
    expect(durableIdOf(ws)).toBe("ws_01J8Z4-workstation-repos");
    expect(ws.routes).toHaveLength(2);
    expect(ws.routes[0]!.type).toBe("local");
    expect(ws.routes[0]!.path).toBe("~/repos");
    expect(ws.routes[1]!.type).toBe("ssh");
    expect(ws.routes[1]!.address).toBe("workstation");
    expect(ws.kindSpec["storageBacked"]).toBe(true);

    const pay = documents.find((d) => d.name === "payments-repo")!;
    expect(durableIdOf(pay)).toBe("ws_01J8Z4-payments-repo");

    // The §2.2 worktree child: shares the parent's fingerprint via lineage.
    const child = documents.find((d) => d.name === "payments-repo-feat-x")!;
    expect(durableIdOf(child)).toBe("ws_01J8Z4-payments-repo-feat-x");
    expect(child.parent).toEqual({ kind: "Workspace", name: "payments-repo" });
  });

  it("skips non-YAML entries and foreign subdirectories with problems, never crashing (flat file loads)", () => {
    const dir = tempDocuments();
    try {
      // Canonical nested layout plus the accepted flat convenience file.
      write(dir, "keep.yaml", readFileSync(join(fixtures, "Workspace", "workstation-repos.yaml"), "utf8"));
      write(dir, "Workspace/README.md", "operator dropped a readme");
      write(dir, "notes.txt", "not yaml");
      write(dir, "operator-dir/stray.yaml", "kind: Workspace");

      const { documents, problems } = loadDirectory(dir);

      expect(documents).toHaveLength(1);
      expect(documents[0]!.name).toBe("workstation-repos");
      expect(documents[0]!.resolvable).toBe(true);
      expect(durableIdOf(documents[0]!)).toBe("ws_01J8Z4-workstation-repos");

      expect(problems).toHaveLength(3);
      const paths = problems.map((p) => p.path).sort();
      expect(paths).toEqual(
        [join(dir, "Workspace", "README.md"), join(dir, "notes.txt"), join(dir, "operator-dir")].sort(),
      );
      for (const p of problems) expect(typeof p.reason).toBe("string");
    } finally {
      cleanup(dir);
    }
  });

  it("wrong apiVersion, missing owner, or unregistered kind loads inert with the reason noted", () => {
    const dir = tempDocuments();
    try {
      write(
        dir,
        "Workspace/bad-version.yaml",
        workspaceYaml("bad-version", "ws_test-bad-version").replace(
          "twill.bitwiseoperations.ca/v1alpha1",
          "twill.example.com/v9beta1",
        ),
      );
      write(dir, "Workspace/no-owner.yaml", workspaceYaml("no-owner", "ws_test-no-owner").replace("  owner: user:test\n", ""));
      write(
        dir,
        "Card/epic.yaml",
        `apiVersion: twill.bitwiseoperations.ca/v1alpha1
kind: Card
metadata: { name: epic }
spec:
  owner: user:test
  routes: []
  card: { id: card_test-epic }
status: {}
`,
      );

      const { documents, problems } = loadDirectory(dir);
      expect(problems).toEqual([]);
      expect(documents).toHaveLength(3);

      const bad = documents.find((d) => d.name === "bad-version")!;
      expect(bad.resolvable).toBe(false);
      expect(bad.inertReasons.join("; ")).toContain("apiVersion");
      expect(durableIdOf(bad)).toBe("ws_test-bad-version");

      const no = documents.find((d) => d.name === "no-owner")!;
      expect(no.resolvable).toBe(false);
      expect(no.inertReasons.join("; ")).toContain("owner");
      expect(durableIdOf(no)).toBe("ws_test-no-owner");

      // T1 registers a kind-runner for Workspace only — other kinds parse inert.
      const card = documents.find((d) => d.name === "epic")!;
      expect(card.resolvable).toBe(false);
      expect(card.inertReasons.join("; ")).toContain("kind-runner");
      expect(durableIdOf(card)).toBe("card_test-epic");
    } finally {
      cleanup(dir);
    }
  });

  it("Workspace missing storage.fingerprint loads inert", () => {
    const dir = tempDocuments();
    try {
      const yaml = workspaceYaml("no-fingerprint", "ws_test-no-fingerprint").replace(
        "storage: { id: ws_test-no-fingerprint, fingerprint: vol-test }",
        "storage: { id: ws_test-no-fingerprint }",
      );
      write(dir, "Workspace/no-fingerprint.yaml", yaml);

      const { documents, problems } = loadDirectory(dir);
      expect(problems).toEqual([]);
      expect(documents).toHaveLength(1);
      const doc = documents[0]!;
      expect(doc.resolvable).toBe(false);
      expect(doc.inertReasons.join("; ")).toContain("fingerprint");
      // durableIdOf is still computed when possible.
      expect(durableIdOf(doc)).toBe("ws_test-no-fingerprint");
    } finally {
      cleanup(dir);
    }
  });

  it("unparseable or non-object YAML becomes a LoadProblem; other files still load", () => {
    const dir = tempDocuments();
    try {
      write(dir, "Workspace/broken.yaml", "kind: [unclosed");
      write(dir, "Workspace/scalar.yaml", "just a string");
      write(dir, "Workspace/good.yaml", workspaceYaml("good", "ws_test-good"));

      const { documents, problems } = loadDirectory(dir);
      expect(documents).toHaveLength(1);
      expect(documents[0]!.name).toBe("good");
      expect(documents[0]!.resolvable).toBe(true);

      expect(problems).toHaveLength(2);
      const broken = problems.find((p) => p.path.endsWith("broken.yaml"))!;
      expect(broken.reason).toContain("YAML");
      const scalar = problems.find((p) => p.path.endsWith("scalar.yaml"))!;
      expect(scalar.reason).toContain("non-object");
    } finally {
      cleanup(dir);
    }
  });
});
