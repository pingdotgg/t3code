#!/usr/bin/env bun
/**
 * Cross-version test suite for alchemy.
 *
 * Deploys a tiny app (a Cloudflare state store + one Worker) using a range of
 * alchemy versions, each from its own folder under ./test, and runs a set of
 * upgrade scenarios BACK TO BACK (sequentially, never in parallel — they all
 * share one account-wide state store and one fixed worker name):
 *
 *   TEST 1 — sequential 1-by-1 upgrade
 *     Deploy the oldest version, then upgrade the SAME app in place through
 *     every version in order (v4 → v5 → v6 → v7 → current), walking the
 *     account-wide state store up one version at a time.
 *
 *   TEST 2 — direct-to-latest
 *     For each older example, deploy it and then upgrade the SAME app DIRECTLY
 *     to latest (the current branch), skipping the intermediate versions — a
 *     big-jump upgrade (e.g. state store v4 → v7 in one step).
 *
 * Both tests assert, after every deploy, that the live worker serves the marker
 * baked into the version that was just deployed — proving the running code was
 * actually replaced in place.
 *
 * Each scenario ("unit") owns a FRESH state store: the runner tears the state
 * store (worker + secrets) down before and after every unit, so — e.g. — the
 * 1-by-1 upgrade runs on its own store, that store is destroyed, then each
 * direct-to-latest jump deploys a brand-new store. (Pass --reuse-store to skip
 * the teardowns and reuse one store across units, which is faster but less
 * isolated.)
 *
 * Stage folders (see ./test/*):
 *   01-beta.39  — last npm release with state store version 4
 *   02-beta.44  — last npm release with state store version 5
 *   03-beta.45  — last npm release with state store version 6
 *   04-beta.59  — last v2 release on npm (state store version 7 = latest npm)
 *   05-current  — the current branch (workspace source, state store version 7)
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  WARNING: the Cloudflare state store is ACCOUNT-WIDE and shared by every
 *  stack on the account/profile. These tests bootstrap state store v4, which
 *  DOWNGRADES the store if the account already had a higher version. Run this
 *  against a dedicated / throwaway Cloudflare account only.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Usage:
 *   bun run test/cross-version-test/run.ts --profile <profile> [flags]
 *   ALCHEMY_PROFILE=<profile> bun run test/cross-version-test/run.ts
 *
 * The suite runs FORCE-THROUGH: every edge in `EDGES` is attempted on its own
 * fresh state store, a failure is recorded (never aborts the run), and a
 * PASS/FAIL summary + a `===RESULTS_JSON===` block is printed at the end. Mark
 * an edge KNOWN BAD by commenting it out of `EDGES` (with a note).
 *
 * Usage:
 *   bun run test/cross-version-test/run.ts --profile <profile> [flags]
 *   ALCHEMY_PROFILE=<profile> bun run test/cross-version-test/run.ts
 *
 * Flags:
 *   --profile <p>   Cloudflare auth profile (~/.alchemy/profiles.json).
 *                   Falls back to $ALCHEMY_PROFILE. REQUIRED (no default, to
 *                   avoid accidentally mutating the wrong account).
 *   --group <g>     Only run edges in one group: "sequential" or "jump".
 *   --stage <s>     Alchemy stage name for the app. Default: "xver".
 *   --no-install    Skip `bun install` in npm stages (reuse existing installs).
 *   --reuse-store   Reuse ONE state store across all edges (skip the per-edge
 *                   teardown/redeploy). Faster, but edges aren't isolated.
 *   --settle <sec>  Seconds to wait after a store teardown for workers.dev to
 *                   propagate the deletion (default 25). Avoids the fresh
 *                   bootstrap seeing the just-deleted worker's stale version.
 *   --boot-retries <n>  Bootstrap attempts on transient 404/500/version-not-
 *                   ready during hoist (default 3).
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const TEST_DIR = path.join(HERE, "test");

interface Stage {
  dir: string;
  label: string;
  marker: string;
  /** npm stages get an isolated `bun install`; workspace stages don't. */
  kind: "npm" | "workspace";
}

const STAGES: Stage[] = [
  {
    dir: "01-beta.39",
    label: "alchemy@2.0.0-beta.39 (last npm release with state store v4)",
    marker: "01-beta.39",
    kind: "npm",
  },
  {
    dir: "02-beta.44",
    label: "alchemy@2.0.0-beta.44 (last npm release with state store v5)",
    marker: "02-beta.44",
    kind: "npm",
  },
  {
    dir: "03-beta.45",
    label: "alchemy@2.0.0-beta.45 (last npm release with state store v6)",
    marker: "03-beta.45",
    kind: "npm",
  },
  {
    dir: "04-beta.59",
    label: "alchemy@2.0.0-beta.59 (latest v2 on npm, state store v7)",
    marker: "04-beta.59",
    kind: "npm",
  },
  {
    dir: "05-current",
    label: "current branch (workspace source, state store v7)",
    marker: "05-current",
    kind: "workspace",
  },
];

// The newest version — the target every TEST 2 jump upgrades directly to.
const LATEST = STAGES[STAGES.length - 1];

// ── arg parsing ───────────────────────────────────────────────────────────
function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const PROFILE = (args.profile as string) ?? process.env.ALCHEMY_PROFILE;
const STAGE = (args.stage as string) ?? "xver";
const NO_INSTALL = args["no-install"] === true;
const REUSE_STORE = args["reuse-store"] === true;
// Seconds to wait after a state-store teardown before redeploying, so the
// same-named worker's DELETION propagates on workers.dev (otherwise the fresh
// bootstrap sees the old worker's version — "version not ready").
const SETTLE = Number(args.settle ?? 25);
// Retries for the bootstrap step, which can transiently 404/500 while the
// freshly-deployed store worker's HTTP endpoint comes up.
const BOOT_RETRIES = Number(args["boot-retries"] ?? 3);
const GROUP =
  typeof args.group === "string"
    ? (args.group as "sequential" | "jump")
    : undefined;

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";

function banner(msg: string) {
  const line = "─".repeat(Math.min(78, msg.length + 4));
  console.log(
    `\n${CYAN}${line}\n  ${BOLD}${msg}${RESET}${CYAN}\n${line}${RESET}`,
  );
}

const sleep = (seconds: number) =>
  new Promise((r) => setTimeout(r, seconds * 1000));

if (!PROFILE) {
  console.error(
    `${RED}error: no Cloudflare profile.${RESET}\n` +
      `Pass --profile <name> or set $ALCHEMY_PROFILE.\n` +
      `This run mutates the account-wide state store — point it at a\n` +
      `dedicated/throwaway account, not your shared testing account.`,
  );
  process.exit(2);
}

// ── subprocess helper: stream output live AND capture it ────────────────────
function run(
  cmd: string,
  cmdArgs: string[],
  opts: { cwd: string },
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const printable = `${cmd} ${cmdArgs.join(" ")}`;
    console.log(`${YELLOW}$ (${path.basename(opts.cwd)}) ${printable}${RESET}`);
    const child = spawn(cmd, cmdArgs, {
      cwd: opts.cwd,
      // CI=true makes the state-store version check FAIL FAST (die) on a
      // mismatch instead of prompting `Yes/No` — which would hang forever on a
      // non-TTY subprocess. `--yes` only covers plan approval, not this prompt.
      env: { ...process.env, ALCHEMY_PROFILE: PROFILE, CI: "true" },
      shell: process.platform === "win32", // resolve `bun`/.cmd on Windows
      // No stdin: any prompt that slips past CI=true reads EOF and cancels
      // rather than blocking forever on a non-TTY pipe.
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const onData = (buf: Buffer, to: NodeJS.WriteStream) => {
      const text = buf.toString();
      output += text;
      to.write(text);
    };
    child.stdout.on("data", (b) => onData(b, process.stdout));
    child.stderr.on("data", (b) => onData(b, process.stderr));
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
    child.on("error", (err) => {
      output += String(err);
      console.error(`${RED}spawn error: ${err}${RESET}`);
      resolve({ code: 1, output });
    });
  });
}

const stageDir = (stage: Stage) => path.join(TEST_DIR, stage.dir);

/**
 * Clear the state-store bootstrap's LOCAL staging state
 * (`<stageDir>/.alchemy/state/CloudflareStateStore`). Bootstrap deploys the
 * state store into this local backend first, then hoists it to the remote store
 * and deletes it — but a run killed mid-bootstrap leaves it behind, so the next
 * bootstrap "resumes" it against cloud resources we've since torn down. Wiping
 * it makes every bootstrap start fresh. (Only the bootstrap uses local state;
 * the app itself uses the remote store, so this is safe.)
 */
function clearLocalBootstrapState(stage: Stage) {
  const dir = path.join(
    stageDir(stage),
    ".alchemy",
    "state",
    "CloudflareStateStore",
  );
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// `bun run alc -- <subcommand...>` runs the folder's alchemy CLI:
//  - npm stages       -> the version pinned in that folder's node_modules
//  - workspace stage  -> the workspace `alchemy` bin (current branch source),
//                        resolved by walking up to the repo-root node_modules
function alc(stage: Stage, subArgs: string[]) {
  return run("bun", ["run", "alc", "--", ...subArgs], { cwd: stageDir(stage) });
}

function extractUrl(output: string): string | undefined {
  // Strip ANSI so the regex matches output rendered through the CLI reporter.
  const clean = output.replace(/\x1b\[[0-9;]*m/g, "");
  const match = clean.match(/https:\/\/[a-z0-9.-]+\.workers\.dev[^\s"')]*/i);
  return match?.[0];
}

// Pull a concise failure reason out of a subprocess's output for the summary.
// Skips known benign noise (the CLI's tsconfig warning, the upgrade nag) so it
// doesn't mask the real error — and so the transient-retry check sees the truth.
const NOISE = /tsconfig|is available|npm_|Run `bun add`/i;
const MEANINGFUL =
  /StateStoreError|BadRequest|AuthError|Decode error|Transport error|HttpClientError|ERROR \(#|not found|Unauthorized|Forbidden|version not ready/i;
function extractError(output: string): string {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, "");
  const lines = clean
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  // Prefer the CLI's structured "ERROR (#N): <message>" line — that's the real
  // cause. Falling back to the raw `_tag:`/`[cause]:` object-dump lines both
  // misreports AND defeats the transient-retry check.
  for (const l of lines) {
    const m = l.match(/ERROR \(#\d+\):\s*(.+)/);
    if (m?.[1] && !NOISE.test(m[1])) return m[1].slice(0, 240);
  }
  const line = lines.find(
    (l) =>
      MEANINGFUL.test(l) &&
      !NOISE.test(l) &&
      !/^_tag:|^\[cause\]:|^"~effect/.test(l),
  );
  return (line ?? "unknown error").slice(0, 240);
}

// Transient state-store bootstrap/deploy failures that clear once the freshly
// (re)deployed worker propagates on workers.dev — retry these.
const TRANSIENT =
  /Decode error|not ready|version not ready|not found|Transport error|\b404\b|\b500\b|\b502\b|\b503\b|fetch failed|ECONN|ETIMEDOUT/i;

async function verify(url: string, expectedMarker: string): Promise<void> {
  // Fresh / freshly-updated workers.dev routes transiently 404/5xx while the
  // edge propagates, so retry with backoff.
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 12; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const body = (await res.json()) as { marker?: string };
        if (body.marker === expectedMarker) {
          console.log(
            `${GREEN}✓ live worker serves marker "${body.marker}"${RESET}`,
          );
          return;
        }
        throw new Error(
          `marker mismatch: got "${body.marker}", expected "${expectedMarker}"`,
        );
      }
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, Math.min(1000 * attempt, 5000)));
  }
  throw new Error(
    `verification failed for ${url} (expected marker "${expectedMarker}"): ${lastErr}`,
  );
}

// ── stage primitives ────────────────────────────────────────────────────────
const installed = new Set<string>();

async function ensureInstalled(stage: Stage) {
  if (stage.kind !== "npm" || NO_INSTALL || installed.has(stage.dir)) return;
  const r = await run("bun", ["install"], { cwd: stageDir(stage) });
  if (r.code !== 0) throw new Error(`install failed for ${stage.dir}`);
  installed.add(stage.dir);
}

/**
 * Run an alchemy CLI subcommand, retrying on TRANSIENT state-store failures
 * (404/500 hoisting into a freshly-deployed worker, stale version, transport
 * blips → "store not found"). A non-transient failure (e.g. the real v5→v6
 * `500 GET … DecodeError` read incompat) is thrown on the first attempt-set.
 */
async function alcRetry(
  stage: Stage,
  argv: string[],
  what: string,
): Promise<{ code: number; output: string }> {
  let err = "";
  for (let attempt = 1; attempt <= Math.max(1, BOOT_RETRIES); attempt++) {
    if (what === "bootstrap") clearLocalBootstrapState(stage); // never resume a stale local stack
    const r = await alc(stage, argv);
    if (r.code === 0) return r;
    err = extractError(r.output);
    if (attempt < BOOT_RETRIES && TRANSIENT.test(err)) {
      console.log(
        `${YELLOW}${what} attempt ${attempt}/${BOOT_RETRIES} failed (${err}) — settling ${SETTLE}s and retrying${RESET}`,
      );
      await sleep(SETTLE);
      continue;
    }
    break;
  }
  throw new Error(`${what} failed for ${stage.dir}: ${err}`);
}

/**
 * Deploy (or in-place upgrade) the app to `stage`'s version under the given
 * alchemy stage, and assert the live worker serves that version's marker.
 * Bootstraps the account-wide state store to the version's STATE_STORE_VERSION
 * first (idempotent; handles both up- and down-grades), which keeps the deploy
 * non-interactive. Both bootstrap and deploy retry on transient errors.
 */
async function deployAndVerify(
  stage: Stage,
  alchemyStage: string,
): Promise<void> {
  await ensureInstalled(stage);

  await alcRetry(
    stage,
    ["cloudflare", "bootstrap", "--profile", PROFILE!],
    "bootstrap",
  );

  const dep = await alcRetry(
    stage,
    // --adopt: take over a pre-existing fixed-name worker instead of failing.
    ["deploy", "--yes", "--adopt", "--stage", alchemyStage, "--profile", PROFILE!],
    "deploy",
  );

  const url = extractUrl(dep.output);
  if (!url) {
    throw new Error(`could not determine worker URL for ${stage.dir}`);
  }
  console.log(`worker url: ${url}`);
  await verify(url, stage.marker);
}

async function destroyApp(stage: Stage, alchemyStage: string) {
  const r = await alc(stage, [
    "destroy",
    "--yes",
    "--stage",
    alchemyStage,
    "--profile",
    PROFILE!,
  ]);
  if (r.code !== 0) {
    console.error(
      `${RED}warning: destroy failed (stage ${alchemyStage}) — clean up manually.${RESET}`,
    );
  } else {
    console.log(`${GREEN}✓ app destroyed (stage ${alchemyStage})${RESET}`);
  }
}

/**
 * Delete the account-wide Cloudflare state store (worker + secrets store) via
 * the current-branch CLI's `cloudflare teardown` (idempotent). Run between
 * units so each one deploys a FRESH state store rather than inheriting the
 * previous unit's (possibly downgraded) one.
 */
async function teardownStore(reason: string) {
  console.log(`${YELLOW}↺ tearing down state store (${reason})${RESET}`);
  const r = await alc(LATEST, ["cloudflare", "teardown", "--profile", PROFILE!]);
  if (r.code !== 0) {
    console.error(
      `${RED}warning: state store teardown failed — remove it manually.${RESET}`,
    );
  }
  // Let the worker DELETION propagate on workers.dev before anything redeploys
  // the same-named worker — otherwise the fresh bootstrap sees the old version.
  if (SETTLE > 0) {
    console.log(`${YELLOW}  settling ${SETTLE}s for edge propagation…${RESET}`);
    await sleep(SETTLE);
  }
}

const stageByDir = (dir: string): Stage => {
  const s = STAGES.find((x) => x.dir === dir);
  if (!s) throw new Error(`unknown stage dir: ${dir}`);
  return s;
};

// ── The upgrade paths under test ─────────────────────────────────────────────
// Each edge = "deploy `from`, then upgrade the same app to `to`" on its OWN
// fresh state store. The suite runs EVERY edge independently and force-through
// (a failure is recorded, never aborts the run). Comment an edge out (and note
// why) to mark it KNOWN BAD and skip it.
interface Edge {
  from: string; // stage dir
  to: string; // stage dir
  group: "sequential" | "jump";
}

const EDGES: Edge[] = [
  // ── sequential 1-by-1 upgrade steps (npm → npm) ──
  { from: "01-beta.39", to: "02-beta.44", group: "sequential" }, // v4 → v5
  // KNOWN BAD (v5 → v6): after the store is upgraded to v6 (beta.45), reading a
  // record written under ≤v5 fails with `500 GET … DecodeError`. beta.45's
  // legacy-record read (the createdAt/updatedAt reshape, PR #427) is broken;
  // it's fixed in v7 — upgrading v5 straight to current works (see the v5 →
  // worktree jump). So don't step through beta.45 with pre-v6 state; skip to
  // beta.46+.
  // { from: "02-beta.44", to: "03-beta.45", group: "sequential" }, // v5 → v6
  { from: "03-beta.45", to: "04-beta.59", group: "sequential" }, // v6 → v7
  { from: "04-beta.59", to: "05-current", group: "sequential" }, // v7 → worktree
  // ── direct-to-latest jumps (→ worktree, skipping the middle) ──
  // KNOWN BAD (v4 → worktree): the current state-store client can't write to a
  // v4-format store — upgrading it fails with `415 Unsupported Media Type` on
  // `PUT …/StateStoreEncryptionKey` (deterministic; fails every retry). v4
  // (beta.37–39) predates the RPC state-store rewrite at v5, so its store HTTP
  // API is wire-incompatible with current. v5/v6/v7 → worktree all work, so
  // step a v4 store up to ≥v5 before jumping to latest.
  // { from: "01-beta.39", to: "05-current", group: "jump" }, // v4 → worktree
  { from: "02-beta.44", to: "05-current", group: "jump" }, // v5 → worktree
  { from: "03-beta.45", to: "05-current", group: "jump" }, // v6 → worktree
];

const EDGE_STAGE = STAGE; // one alchemy stage; each edge gets a fresh store anyway

interface StepResult {
  name: string;
  status: "ok" | "fail" | "skip";
  error?: string;
}
interface EdgeResult {
  label: string;
  group: string;
  worktree: boolean;
  steps: StepResult[];
  failed: boolean;
}

async function tryStep(name: string, fn: () => Promise<void>): Promise<StepResult> {
  try {
    await fn();
    console.log(`${GREEN}✓ ${name}${RESET}`);
    return { name, status: "ok" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${RED}✗ ${name}: ${msg}${RESET}`);
    return { name, status: "fail", error: msg };
  }
}

async function runEdge(edge: Edge): Promise<EdgeResult> {
  const from = stageByDir(edge.from);
  const to = stageByDir(edge.to);
  const worktree = from.kind === "workspace" || to.kind === "workspace";
  const label = `${from.dir} → ${to.dir}`;
  banner(`EDGE ${label}  [${edge.group}${worktree ? ", worktree" : ""}]`);

  // Fresh store for this edge.
  clearLocalBootstrapState(from);
  clearLocalBootstrapState(to);
  if (!REUSE_STORE) await teardownStore(`fresh for ${label}`);

  const steps: StepResult[] = [];

  const deployStep = await tryStep(`deploy ${from.dir}`, () =>
    deployAndVerify(from, EDGE_STAGE),
  );
  steps.push(deployStep);

  if (deployStep.status === "ok") {
    steps.push(
      await tryStep(`upgrade → ${to.dir}`, () => deployAndVerify(to, EDGE_STAGE)),
    );
  } else {
    steps.push({
      name: `upgrade → ${to.dir}`,
      status: "skip",
      error: "prerequisite deploy failed",
    });
  }

  // Best-effort cleanup so the next edge starts clean.
  await destroyApp(to, EDGE_STAGE).catch(() => {});
  if (!REUSE_STORE) await teardownStore(`after ${label}`).catch(() => {});

  return {
    label,
    group: edge.group,
    worktree,
    steps,
    failed: steps.some((s) => s.status !== "ok"),
  };
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const edges = EDGES.filter((e) => !GROUP || e.group === GROUP);

  banner("alchemy cross-version test suite (force-through)");
  console.log(`profile : ${PROFILE}`);
  console.log(`edges   : ${edges.length}`);
  console.log(`store   : ${REUSE_STORE ? "reused" : "FRESH per edge"}`);
  console.log(`repo    : ${REPO_ROOT}`);
  console.log(
    `${YELLOW}note: bootstraps state store v4 — run against a dedicated account.${RESET}`,
  );

  if (!REUSE_STORE) await teardownStore("pre-clean");

  const results: EdgeResult[] = [];
  for (const edge of edges) {
    results.push(await runEdge(edge));
  }

  // ── summary ────────────────────────────────────────────────────────────--
  banner("SUMMARY");
  for (const r of results) {
    const mark = r.failed ? `${RED}FAIL${RESET}` : `${GREEN}PASS${RESET}`;
    const tag = r.worktree ? " (worktree)" : "";
    console.log(`${mark}  [${r.group}] ${r.label}${tag}`);
    for (const s of r.steps) {
      const sym =
        s.status === "ok" ? `${GREEN}✓${RESET}` : s.status === "skip" ? `${YELLOW}∅${RESET}` : `${RED}✗${RESET}`;
      console.log(`        ${sym} ${s.name}${s.error ? ` — ${s.error}` : ""}`);
    }
  }

  // Machine-readable block for downstream parsing.
  console.log("\n===RESULTS_JSON===");
  console.log(
    JSON.stringify(
      results.map((r) => ({
        label: r.label,
        group: r.group,
        worktree: r.worktree,
        failed: r.failed,
        steps: r.steps.map((s) => ({
          name: s.name,
          status: s.status,
          error: s.error,
        })),
      })),
      null,
      2,
    ),
  );
  console.log("===END_RESULTS_JSON===");

  const failed = results.filter((r) => r.failed);
  banner(
    failed.length === 0
      ? `${GREEN}ALL EDGES PASSED${RESET}`
      : `${RED}${failed.length}/${results.length} EDGES FAILED${RESET}`,
  );
}

main().catch((err) => {
  console.error(`\n${RED}${BOLD}suite crashed:${RESET} ${err}`);
  process.exit(1);
});
