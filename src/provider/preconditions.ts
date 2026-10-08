// Precondition executors (T2.5 Task 2) — the provider-side half of the
// workspace §7 step vocabulary. The provider (Task 3) runs a route's
// `precondition.steps[]` to materialize a workspace before reporting ready;
// v1 implements the two local steps (`gitClone`, `worktree`) and rejects the
// rest (`pvcBind`, `remoteMkdir`, `mountCheck`) with the spec's
// "unsupported precondition step: <type>" error — the provider must not
// pretend to materialize what it can't.
//
// Semantics (workspace §7, provider spec §5.2):
// - gitClone {url, ref}: clone into workDir if absent; if present, fetch and
//   verify `ref` is checked out and clean — no-op on match; fast-forward if
//   clean and behind; FAIL on dirty or diverged.
// - worktree {repo, branch, base?}: idempotent `git worktree add` — a
//   worktree already registered for the branch AT the claim's placement
//   path is a no-op; FAIL when the branch is checked out at any other path
//   (git's own elsewhere-checkout error surfaces; Review Focus #2). `base`
//   is the start point for a new branch.
// - String fields substitute `{{claim.parameters.<name>}}` from the claim's
//   parameters (registry-implementation-owned syntax, workspace §7).
//
// Placement rule: the clone/worktree path is <workDir>/<worktreeName> when
// the claim carries a worktreeName (worktree claims — the child path the
// provider PATCHes into the child route), else <workDir>/<ref-or-branch>
// (cold-root claims). All git runs through execFile with an argv array —
// no shell, so no injection surface; stderr is captured into error text.
// Executors are async and never throw: failures come back as
// {ok:false, error}.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** A gitClone step (workspace §7). `credentials` is reserved (v1 ignores it). */
export type GitCloneStep = { type: "gitClone"; url: string; ref: string; credentials?: string };

/** A worktree step (workspace §7). `base` is the start point for a new branch. */
export type WorktreeStep = { type: "worktree"; repo: string; branch: string; base?: string };

/**
 * Any precondition step. The v1-implemented kinds are the named members;
 * every other kind rides the open member and is rejected at run time.
 */
export type PreconditionStep =
  | GitCloneStep
  | WorktreeStep
  | ({ type: string } & Record<string, unknown>);

/** Execution context: the claim's parameters plus the directory the step materializes into. */
export type PreconditionContext = {
  claimParameters: Record<string, string>;
  workDir: string;
};

export type PreconditionResult = { ok: true; path?: string } | { ok: false; error: string };

type GitResult = { code: number; stdout: string; stderr: string };

/** Run git with an argv array (no shell); resolve on any exit. */
function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolvePromise, reject) => {
    execFile("git", ["-C", cwd, ...args], (error, stdout, stderr) => {
      if (error !== null && typeof error.code !== "number") {
        reject(error); // spawn itself failed (ENOENT etc.) — not a git exit
        return;
      }
      resolvePromise({
        code: error === null ? 0 : (error.code as number),
        stdout: stdout.toString(),
        stderr: stderr.toString(),
      });
    });
  });
}

/** Git failure error text: stderr carries the message; fall back to the exit code. */
function gitError(command: string, result: GitResult): string {
  const detail = result.stderr.trim();
  return detail === "" ? `${command} exited ${result.code}` : detail;
}

/** Substitute `{{claim.parameters.<name>}}` placeholders from the claim's parameters. */
function substitute(value: string, parameters: Record<string, string>): string | undefined {
  const pattern = /\{\{claim\.parameters\.([A-Za-z0-9_-]+)\}\}/g;
  if (!pattern.test(value)) return value;
  let missing: string | undefined;
  const replaced = value.replace(pattern, (raw: string, name: string) => {
    const parameter = parameters[name];
    if (parameter === undefined) {
      missing = raw;
      return raw;
    }
    return parameter;
  });
  return missing === undefined ? replaced : undefined;
}

/**
 * The first `{{claim.parameters.*}}` placeholder found across the named
 * string fields of a step (spec order: url/ref/repo/branch/base) — used to
 * name the unresolved parameter in the error when a substitution failed.
 */
function firstPlaceholder(step: Record<string, unknown>, fields: string[]): string | undefined {
  for (const field of fields) {
    const value = step[field];
    if (typeof value !== "string") continue;
    const names = [...value.matchAll(/\{\{claim\.parameters\.([A-Za-z0-9_-]+)\}\}/g)].map((m) => m[1]);
    if (names.length > 0) return `{{claim.parameters.${names[0]}}}`;
  }
  return undefined;
}

/** <workDir>/<worktreeName> for worktree claims; <workDir>/<leaf> for cold-root. */
function placement(ctx: PreconditionContext, leaf: string): string {
  const name = ctx.claimParameters["worktreeName"];
  return join(ctx.workDir, name !== undefined && name !== "" ? name : leaf);
}

async function gitClone(step: GitCloneStep, ctx: PreconditionContext): Promise<PreconditionResult> {
  if (typeof step.url !== "string" || typeof step.ref !== "string") {
    return { ok: false, error: "gitClone: step requires url and ref strings" };
  }
  const url = substitute(step.url, ctx.claimParameters);
  const ref = substitute(step.ref, ctx.claimParameters);
  if (url === undefined || ref === undefined) {
    return { ok: false, error: `unresolved claim parameter: ${firstPlaceholder(step, ["url", "ref"])}` };
  }
  const path = placement(ctx, ref);
  if (!existsSync(path)) {
    const result = await git(ctx.workDir, ["clone", url, path]);
    if (result.code !== 0) return { ok: false, error: gitError(`git clone ${url}`, result) };
    // The clone lands on origin's default branch; move it onto `ref`.
    const checkout = await git(path, ["checkout", ref]);
    if (checkout.code !== 0) return { ok: false, error: gitError(`git checkout ${ref}`, checkout) };
    return { ok: true, path };
  }
  // Present: fetch, then no-op on match / ff if clean+behind / FAIL dirty or diverged.
  // The target is the REMOTE's tip for ref (FETCH_HEAD after fetch) — never
  // the local branch of the same name, which a fresh clone leaves stale.
  const fetch = await git(path, ["fetch", "origin", ref]);
  if (fetch.code !== 0) return { ok: false, error: gitError(`git fetch origin ${ref}`, fetch) };
  const tipResult = await git(path, ["rev-parse", "--verify", "FETCH_HEAD"]);
  if (tipResult.code !== 0) return { ok: false, error: gitError("git rev-parse FETCH_HEAD", tipResult) };
  const tip = tipResult.stdout.trim();

  // Dirty check: porcelain v2 branch format — stable, includes untracked.
  const status = await git(path, ["status", "--porcelain=v2", "--branch"]);
  if (status.code !== 0) return { ok: false, error: gitError("git status", status) };
  const dirty = status.stdout.split("\n").some((line) => line !== "" && !line.startsWith("# "));
  if (dirty) {
    return { ok: false, error: `gitClone: ${path} has a dirty working tree at ref ${ref}` };
  }

  const head = await git(path, ["rev-parse", "--verify", "HEAD"]);
  if (head.code !== 0) return { ok: false, error: gitError("git rev-parse HEAD", head) };
  if (head.stdout.trim() === tip) return { ok: true, path }; // no-op on match

  const ancestor = await git(path, ["merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD"]);
  if (ancestor.code !== 0) {
    return { ok: false, error: `gitClone: ${path} has diverged from ${ref}; cannot fast-forward` };
  }
  // If HEAD is attached to a local branch named <ref>, stay attached and
  // fast-forward the branch; otherwise detach at the remote tip.
  const symbolic = await git(path, ["symbolic-ref", "--quiet", "HEAD"]);
  const attachedToRef = symbolic.code === 0 && symbolic.stdout.trim() === `refs/heads/${ref}`;
  if (!attachedToRef) {
    const checkout = await git(path, ["checkout", "--detach", "FETCH_HEAD"]);
    if (checkout.code !== 0) return { ok: false, error: gitError("git checkout --detach FETCH_HEAD", checkout) };
  }
  const merge = await git(path, ["merge", "--ff-only", "FETCH_HEAD"]);
  if (merge.code !== 0) return { ok: false, error: gitError("git merge --ff-only FETCH_HEAD", merge) };
  return { ok: true, path };
}

/** Parse `git worktree list --porcelain` into path → branch-short-name rows. */
async function worktreeBranches(repo: string): Promise<Map<string, string> | { error: string }> {
  const result = await git(repo, ["worktree", "list", "--porcelain"]);
  if (result.code !== 0) return { error: gitError("git worktree list", result) };
  const branches = new Map<string, string>();
  let currentPath: string | undefined;
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length);
    } else if (line.startsWith("branch refs/heads/") && currentPath !== undefined) {
      branches.set(currentPath, line.slice("branch refs/heads/".length));
    }
  }
  return branches;
}

async function worktree(step: WorktreeStep, ctx: PreconditionContext): Promise<PreconditionResult> {
  if (typeof step.repo !== "string" || typeof step.branch !== "string") {
    return { ok: false, error: "worktree: step requires repo and branch strings" };
  }
  if (step.base !== undefined && typeof step.base !== "string") {
    return { ok: false, error: "worktree: base must be a string" };
  }
  const repo = substitute(step.repo, ctx.claimParameters);
  const branch = substitute(step.branch, ctx.claimParameters);
  // `base` participates only when the step carries one.
  const base = step.base !== undefined ? substitute(step.base, ctx.claimParameters) : undefined;
  const baseUnresolved = step.base !== undefined && base === undefined;
  if (repo === undefined || branch === undefined || baseUnresolved) {
    return {
      ok: false,
      error: `unresolved claim parameter: ${firstPlaceholder(step, ["repo", "branch", "base"])}`,
    };
  }
  const path = placement(ctx, branch);
  const branches = await worktreeBranches(repo);
  if ("error" in branches) return { ok: false, error: branches.error };
  // Idempotence is placement-keyed: a worktree already registered for the
  // branch AT the claim's placement path is a no-op. A branch checked out at
  // any OTHER path is not this claim's materialization — fall through to
  // `git worktree add`, which FAILs with the elsewhere-checkout error
  // (Review Focus #2) rather than silently reusing a foreign checkout.
  for (const [existingPath, existing] of branches) {
    if (existing === branch && existingPath === path) return { ok: true, path };
  }
  const args = ["worktree", "add"];
  const localBranch = await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (localBranch.code !== 0 && base !== undefined) {
    // New branch from `base`.
    args.push("-b", branch, path, base);
  } else {
    // Existing branch, or no base: let git's own error surface (this is where
    // the elsewhere-checkout FAIL comes from).
    args.push(path, branch);
  }
  const result = await git(repo, args);
  if (result.code !== 0) return { ok: false, error: gitError(`git ${args.join(" ")}`, result) };
  return { ok: true, path };
}

/**
 * Execute one precondition step. Never throws: git failures, unresolved
 * parameters, and unsupported kinds all come back as {ok:false, error}.
 */
export async function runPrecondition(
  step: PreconditionStep,
  ctx: PreconditionContext,
): Promise<PreconditionResult> {
  if (step.type !== "gitClone" && step.type !== "worktree") {
    return { ok: false, error: `unsupported precondition step: ${step.type}` };
  }
  // The executor owns the materialization area: ensure the claim's
  // placement root exists (git -C requires the directory).
  mkdirSync(ctx.workDir, { recursive: true });
  // The open union member defeats narrow(); the type check above plus the
  // per-field guards inside the executors make the cast sound.
  return step.type === "gitClone"
    ? gitClone(step as GitCloneStep, ctx)
    : worktree(step as WorktreeStep, ctx);
}
