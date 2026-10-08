// Precondition executor tests (T2.5 Task 2) — the provider-side halves of
// the workspace §7 step vocabulary: `gitClone` (clone if absent; no-op on
// match; ff if clean+behind; FAIL on dirty/diverged) and `worktree`
// (idempotent add; FAIL on branch-checked-out-elsewhere — Review Focus #2),
// plus `{{claim.parameters.*}}` substitution and the unsupported-step
// rejection for the v1-out-of-scope kinds (pvcBind/remoteMkdir/mountCheck).
//
// Fixtures are real git repos built in a tmpdir per test: a bare origin, a
// seed clone that authors commits (the only repo that pushes), and — for
// clone tests — a working clone that stays detached-HEAD so its HEAD is free
// to track whatever `ref` the step asks for. `workDir` is a tmpdir the
// executors place clones/worktrees inside (the claim's path stem).
//
// Git is driven through execFile exactly as the executors drive it (no
// shell). The user's global config enforces ssh commit signing, so the
// seed/working repos set commit.gpgsign=false locally — the fixtures must
// be able to commit without the user's keys.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPrecondition, type PreconditionContext } from "./preconditions.js";

const tempDirs: string[] = [];

let root: string;
let origin: string;
let seed: string;
let workDir: string;
let ctx: PreconditionContext;

/** Run a git command; reject (with stderr) on nonzero exit. */
function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`git ${args.join(" ")}: ${stderr.trim() || error.message}`));
          return;
        }
        resolvePromise(stdout.toString());
      },
    );
  });
}

/** Commit a file in the seed repo (the only fixture repo that pushes).
 *  GIT_COMMITTER_DATE is set explicitly so two commits in the same test get
 *  distinct SHAs (git's commit granularity is 1s; the author date alone is
 *  not enough — the committer date also feeds the tree-hash). */
let commitCounter = 0;

async function seedCommit(file: string, contents: string, message: string): Promise<void> {
  writeFileSync(join(seed, file), contents);
  await git(seed, ["add", "."]);
  const when = new Date(1_700_000_000_000 + commitCounter++ * 60_000).toISOString();
  await git(seed, ["-c", `user.date=${when}`, "commit", "-qm", message], {
    GIT_COMMITTER_DATE: when,
  });
}

async function seedPush(refspec: string): Promise<void> {
  await git(seed, ["push", "-q", "origin", refspec]);
}

/** Clone origin into <root>/repo and detach HEAD — the `repo` argument for worktree steps. */
async function makeRepoClone(): Promise<string> {
  const repo = join(root, "repo");
  await git(root, ["clone", "-q", origin, repo]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  await git(repo, ["checkout", "-q", "--detach", "HEAD"]);
  return repo;
}

/** Clone origin into <workDir>/main — the executor's placement path for a
 *  gitClone with ref=main — and detach HEAD (so any ref is switchable). */
async function makePresentClone(): Promise<string> {
  const repo = join(workDir, "main");
  mkdirSync(workDir, { recursive: true });
  await git(workDir, ["clone", "-q", origin, repo]);
  // Hermetic identity: the clone's origin is a local path, so no conditional
  // includeIf fires and the gecos is empty — without an
  // explicit identity the diverged test's commit fails with "Author identity
  // unknown" on hosts where git can't auto-derive one.
  await git(repo, ["config", "user.email", "fixture@twill"]);
  await git(repo, ["config", "user.name", "fixture"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  await git(repo, ["checkout", "-q", "--detach", "HEAD"]);
  return repo;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "twill-precond-"));
  tempDirs.push(root);
  origin = join(root, "origin.git");
  seed = join(root, "seed");
  workDir = join(root, "work");
  ctx = { claimParameters: {}, workDir };
  await git(root, ["init", "--bare", origin]);
  await git(root, ["clone", "-q", origin, seed]);
  await git(seed, ["config", "user.email", "fixture@twill"]);
  await git(seed, ["config", "user.name", "fixture"]);
  await git(seed, ["config", "commit.gpgsign", "false"]);
  await seedCommit("f.txt", "v1\n", "c1");
  await seedPush("HEAD:main");
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("gitClone", () => {
  it("clones when the target is absent and returns its path", async () => {
    const result = await runPrecondition({ type: "gitClone", url: origin, ref: "main" }, ctx);
    expect(result).toEqual({ ok: true, path: join(workDir, "main") });
    expect(readFileSync(join(workDir, "main", "f.txt"), "utf8")).toBe("v1\n");
    // Fresh clones sit on the default branch (main).
    expect((await git(join(workDir, "main"), ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("main");
  });

  it("is a no-op when the ref is already checked out at its tip", async () => {
    const repo = await makePresentClone();
    // Point the existing clone at main's tip: the state the executor must no-op on.
    await git(repo, ["fetch", "-q", "origin", "main"]);
    await git(repo, ["checkout", "-q", "origin/main"]);
    const result = await runPrecondition({ type: "gitClone", url: origin, ref: "main" }, ctx);
    expect(result).toEqual({ ok: true, path: repo });
    expect((await git(repo, ["rev-parse", "HEAD"])).trim()).toBe(
      (await git(repo, ["rev-parse", "origin/main"])).trim(),
    );
  });

  it("fast-forwards when the clone is clean and behind", async () => {
    const repo = await makePresentClone();
    const before = (await git(repo, ["rev-parse", "HEAD"])).trim();
    await seedCommit("f.txt", "v2\n", "c2");
    await seedPush("HEAD:main");
    const after = (await git(seed, ["rev-parse", "HEAD"])).trim();
    expect(after).not.toBe(before); // the seed actually advanced main
    // The clone still sits at the old commit — a clean, behind state.
    const result = await runPrecondition({ type: "gitClone", url: origin, ref: "main" }, ctx);
    expect(result).toEqual({ ok: true, path: repo });
    expect((await git(repo, ["rev-parse", "HEAD"])).trim()).toBe(after);
    expect(readFileSync(join(repo, "f.txt"), "utf8")).toBe("v2\n");
  });

  it("FAILs on a dirty tree (no checkout, no merge)", async () => {
    const repo = await makePresentClone();
    writeFileSync(join(repo, "f.txt"), "tampered\n");
    const result = await runPrecondition({ type: "gitClone", url: origin, ref: "main" }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/dirty/i);
    // The tree is untouched: still at the original commit with the dirty file.
    expect(readFileSync(join(repo, "f.txt"), "utf8")).toBe("tampered\n");
  });

  it("FAILs on a diverged clone (clean but not a ff)", async () => {
    const repo = await makePresentClone();
    // Local commit on top of c1; seed advances main to c2 → diverged.
    writeFileSync(join(repo, "f.txt"), "local\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-qm", "local"]);
    await seedCommit("f.txt", "v2\n", "c2");
    await seedPush("HEAD:main");
    const result = await runPrecondition({ type: "gitClone", url: origin, ref: "main" }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/diverged|fast-forward/i);
  });

  it("FAILs when the ref does not exist on the remote", async () => {
    const result = await runPrecondition({ type: "gitClone", url: origin, ref: "no-such-ref" }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no-such-ref/);
  });
});

describe("worktree", () => {
  it("adds a new worktree for a branch and returns its path", async () => {
    await seedCommit("g.txt", "g\n", "c2");
    await git(seed, ["branch", "feature-a"]);
    await seedPush("HEAD:main");
    await seedPush("feature-a");
    const repo = await makeRepoClone();
    const result = await runPrecondition({ type: "worktree", repo, branch: "feature-a" }, ctx);
    expect(result).toEqual({ ok: true, path: join(workDir, "feature-a") });
    expect(readFileSync(join(workDir, "feature-a", "g.txt"), "utf8")).toBe("g\n");
    expect((await git(join(workDir, "feature-a"), ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("feature-a");
  });

  it("is a no-op when a worktree already exists for the branch", async () => {
    await git(seed, ["branch", "feature-a"]);
    await seedPush("feature-a");
    const repo = await makeRepoClone();
    const first = await runPrecondition({ type: "worktree", repo, branch: "feature-a" }, ctx);
    expect(first.ok).toBe(true);
    // Dirty the existing worktree: a second run must return its path without touching it.
    if (first.ok && first.path !== undefined) {
      writeFileSync(join(first.path, "scratch.txt"), "uncommitted\n");
    }
    const second = await runPrecondition({ type: "worktree", repo, branch: "feature-a" }, ctx);
    expect(second).toEqual(first);
  });

  it("creates a new branch from `base` when the branch does not exist", async () => {
    const repo = await makeRepoClone();
    const result = await runPrecondition({ type: "worktree", repo, branch: "brand-new", base: "origin/main" }, ctx);
    expect(result).toEqual({ ok: true, path: join(workDir, "brand-new") });
    expect(readFileSync(join(workDir, "brand-new", "f.txt"), "utf8")).toBe("v1\n");
    expect((await git(join(workDir, "brand-new"), ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("brand-new");
  });

  it("FAILs when the branch is checked out in another worktree under a different claim name (Review Focus #2)", async () => {
    await git(seed, ["branch", "feature-a"]);
    await seedPush("feature-a");
    const repo = await makeRepoClone();
    const first = await runPrecondition({ type: "worktree", repo, branch: "feature-a" }, ctx);
    expect(first.ok).toBe(true);
    // A second claim asks for the same branch under a different worktreeName.
    // Idempotence is keyed on the CLAIM's placement path (the branch's
    // existing worktree at a DIFFERENT path is not this claim's
    // materialization), so the request reaches git — which refuses a second
    // checkout, and the error surfaces.
    const collision = await runPrecondition(
      { type: "worktree", repo, branch: "feature-a" },
      { claimParameters: { worktreeName: "other-claim" }, workDir },
    );
    expect(collision.ok).toBe(false);
    if (!collision.ok) expect(collision.error).toMatch(/already used by worktree|already checked out/i);
    // Nothing materialized under the colliding claim's name.
    expect(existsSync(join(workDir, "other-claim"))).toBe(false);
  });

  it("FAILs when the branch is checked out in the repo's main worktree (Review Focus #2)", async () => {
    await git(seed, ["branch", "feature-a"]);
    await seedPush("feature-a");
    const repo = await makeRepoClone();
    // The operator has the branch checked out in the repo's own main worktree
    // — the provider must not hijack it; git's error surfaces.
    await git(repo, ["checkout", "feature-a"]);
    const result = await runPrecondition({ type: "worktree", repo, branch: "feature-a" }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/already used by worktree|already checked out/i);
    expect(existsSync(join(workDir, "feature-a"))).toBe(false);
  });

  it("FAILs when the repo path is not a git repository", async () => {
    const result = await runPrecondition({ type: "worktree", repo: join(root, "no-such-repo"), branch: "x" }, ctx);
    expect(result.ok).toBe(false);
  });
});

describe("parameter substitution", () => {
  it("substitutes {{claim.parameters.branch}} and {{claim.parameters.worktreeName}}", async () => {
    await git(seed, ["branch", "feat-x"]);
    await seedPush("feat-x");
    const repo = await makeRepoClone();
    const result = await runPrecondition(
      { type: "worktree", repo, branch: "{{claim.parameters.branch}}" },
      { claimParameters: { branch: "feat-x", worktreeName: "wt1" }, workDir },
    );
    expect(result).toEqual({ ok: true, path: join(workDir, "wt1") });
    expect((await git(join(workDir, "wt1"), ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("feat-x");
  });

  it("substitutes url and ref on gitClone", async () => {
    await git(seed, ["branch", "templated"]);
    await seedPush("templated");
    const result = await runPrecondition(
      { type: "gitClone", url: "{{claim.parameters.remote}}", ref: "{{claim.parameters.branch}}" },
      { claimParameters: { remote: origin, branch: "templated", worktreeName: "w" }, workDir },
    );
    expect(result).toEqual({ ok: true, path: join(workDir, "w") });
    expect((await git(join(workDir, "w"), ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("templated");
  });

  it("FAILs when a referenced claim parameter is absent", async () => {
    const repo = await makeRepoClone();
    const result = await runPrecondition(
      { type: "worktree", repo, branch: "{{claim.parameters.branch}}" },
      { claimParameters: { worktreeName: "w" }, workDir },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/claim\.parameters\.branch/);
    // Nothing materialized.
    expect(existsSync(join(workDir, "w"))).toBe(false);
  });
});

describe("unsupported steps", () => {
  it.each(["pvcBind", "remoteMkdir", "mountCheck"])("rejects %s", async (type) => {
    const result = await runPrecondition({ type }, ctx);
    expect(result).toEqual({ ok: false, error: `unsupported precondition step: ${type}` });
  });
});
