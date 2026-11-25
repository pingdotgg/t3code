// @effect-diagnostics nodeBuiltinImport:off -- Fork: the source updater drives git and the build as long-lived shell steps.
// @effect-diagnostics globalFetch:off -- Best-effort release notes from GitHub's public API.
// @effect-diagnostics extendsNativeError:off -- Only carries a user-facing message between promise steps.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { DesktopUpdateState } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import { normalizeDesktopUpdateReleaseNotes } from "./releaseNotes.ts";
import { createInitialDesktopUpdateState } from "./updateMachine.ts";

// Fork: Kaluwa has no release feed. It updates itself by merging upstream's newest nightly tag
// into its source checkout, rebuilding in the background, and restarting into the new build.

interface SourceInfo {
  readonly repoRoot: string;
  readonly commit: string;
}

interface CommandResult {
  readonly code: number;
  readonly output: string;
}

interface UpdatePlan {
  readonly kind: "update";
  readonly tag: string;
  readonly merge: boolean;
  /** Nightly tags the running build lacks, newest first. */
  readonly newTags: readonly string[];
}

type Plan = { readonly kind: "up-to-date"; readonly tag: string } | UpdatePlan;

interface MergeConflict {
  readonly tag: string;
  readonly files: readonly string[];
  readonly report: string;
}

class SourceUpdateError extends Error {}

const SHELL_SETUP = 'source "$HOME/.config/vite-plus/env" >/dev/null 2>&1; ';
const FORK_BRANCH = "custom";
const STAGING_DIR = ".kaluwa-update";
const UPSTREAM_REPO = "pingdotgg/t3code";
const MAX_NOTE_RELEASES = 6;
const MAX_CONFLICT_DIFF = 60_000;

function readSourceInfo(candidates: readonly string[]): SourceInfo | null {
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(NodeFS.readFileSync(candidate, "utf8"));
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "repoRoot" in parsed &&
        "commit" in parsed &&
        typeof parsed.repoRoot === "string" &&
        typeof parsed.commit === "string"
      ) {
        return { repoRoot: parsed.repoRoot, commit: parsed.commit };
      }
    } catch {
      continue;
    }
  }
  return null;
}

function childEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("ELECTRON_") && !key.startsWith("T3CODE_"),
    ),
  );
}

function makeRunner(repoRoot: string, logPath: string) {
  return (command: string): Promise<CommandResult> =>
    new Promise((resolve) => {
      NodeFS.appendFileSync(logPath, `\n$ ${command}\n`);
      const child = NodeChildProcess.spawn("/bin/zsh", ["-lc", SHELL_SETUP + command], {
        cwd: repoRoot,
        env: childEnvironment(),
      });
      let output = "";
      const collect = (chunk: Buffer) => {
        NodeFS.appendFileSync(logPath, chunk);
        output = (output + chunk.toString()).slice(-(MAX_CONFLICT_DIFF * 2));
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.on("error", (error) => resolve({ code: -1, output: error.message }));
      child.on("close", (code) => resolve({ code: code ?? -1, output: output.trim() }));
    });
}

// A login shell can print from its profile, so only the last line is the command's answer.
function lastLine(output: string): string {
  return output.split("\n").at(-1)?.trim() ?? "";
}

async function planUpdate(
  run: (command: string) => Promise<CommandResult>,
  builtCommit: string,
): Promise<Plan> {
  const branch = await run("git rev-parse --abbrev-ref HEAD");
  if (lastLine(branch.output) !== FORK_BRANCH) {
    throw new SourceUpdateError(`The source checkout must be on the ${FORK_BRANCH} branch.`);
  }
  const clean = await run('test -z "$(git status --porcelain --untracked-files=no)"');
  if (clean.code !== 0) {
    throw new SourceUpdateError("The source checkout has uncommitted changes. Commit them first.");
  }
  const fetch = await run("git fetch upstream --tags --quiet");
  if (fetch.code !== 0) {
    throw new SourceUpdateError("Could not fetch upstream. Check your network connection.");
  }
  const newest = await run(
    "git for-each-ref --sort=-creatordate --count=1 --format='%(refname:short)' 'refs/tags/v*-nightly.*'",
  );
  const tag = lastLine(newest.output);
  if (newest.code !== 0 || tag === "") {
    throw new SourceUpdateError("Could not find an upstream nightly tag.");
  }
  if ((await run(`git merge-base --is-ancestor ${tag} ${builtCommit}`)).code === 0) {
    return { kind: "up-to-date", tag };
  }
  const merged = (await run(`git merge-base --is-ancestor ${tag} HEAD`)).code === 0;
  const unmerged = await run(
    `git tag --no-merged ${builtCommit} --sort=-creatordate -l 'v*-nightly.*'`,
  );
  const newTags = unmerged.output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^v[\w.]+-nightly\.[\w.]+$/.test(line))
    .slice(0, MAX_NOTE_RELEASES);
  return { kind: "update", tag, merge: !merged, newTags: newTags.length > 0 ? newTags : [tag] };
}

async function fetchReleaseNotes(tags: readonly string[]) {
  const entries: Array<{ readonly version: string; readonly note: string }> = [];
  let releasedAt: string | undefined;
  for (const tag of tags) {
    try {
      const response = await fetch(
        `https://api.github.com/repos/${UPSTREAM_REPO}/releases/tags/${encodeURIComponent(tag)}`,
        {
          headers: { Accept: "application/vnd.github.html+json" },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) continue;
      const release = (await response.json()) as {
        readonly body_html?: unknown;
        readonly published_at?: unknown;
      };
      if (typeof release.body_html !== "string") continue;
      entries.push({ version: tag.replace(/^v/, ""), note: release.body_html });
      if (releasedAt === undefined && typeof release.published_at === "string") {
        releasedAt = release.published_at;
      }
    } catch {
      continue;
    }
  }
  return { entries, releasedAt };
}

async function describeConflict(
  run: (command: string) => Promise<CommandResult>,
  repoRoot: string,
  tag: string,
  mergeOutput: string,
): Promise<MergeConflict> {
  const files = (await run("git diff --name-only --diff-filter=U")).output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.includes(" "));
  const head = lastLine((await run("git rev-parse --short HEAD")).output);
  const diff = (await run("git diff")).output;
  const shownDiff =
    diff.length > MAX_CONFLICT_DIFF
      ? `${diff.slice(0, MAX_CONFLICT_DIFF)}\n… (diff truncated; run the merge to see the rest)`
      : diff;
  const report = [
    `Merge upstream nightly ${tag} into the Kaluwa fork and resolve the conflicts.`,
    "",
    `Repository: ${repoRoot}`,
    `Branch: ${FORK_BRANCH} (HEAD ${head})`,
    `Nightly tag: ${tag}`,
    "",
    "Kaluwa's updater ran this and cancelled it with `git merge --abort`, so the checkout is clean:",
    `  git merge --no-edit -m "Merge nightly ${tag} into custom" ${tag}`,
    "",
    "Git said:",
    mergeOutput,
    "",
    "Conflicting files:",
    ...(files.length > 0 ? files.map((file) => `- ${file}`) : ["- (git listed none)"]),
    "",
    "Conflict diff:",
    "```diff",
    shownDiff,
    "```",
    "",
    "Steps:",
    `1. Run the merge above on ${FORK_BRANCH}.`,
    "2. Resolve each conflict: keep upstream's new behavior and re-apply the fork change on top. Fork changes are marked with `// Fork:` comments; `git log upstream/main..custom` lists them.",
    '3. Follow "Syncing with upstream" in AGENTS.md: commit the merge, run `vp i`, typecheck apps/desktop and packages/contracts, and run the related tests.',
    "4. Then click Check for updates in Kaluwa again: it rebuilds from the merged checkout and offers a restart.",
  ].join("\n");
  return { tag, files, report };
}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const source = readSourceInfo(environment.resolveResourcePathCandidates("kaluwa-source.json"));
  const appBundle = NodePath.resolve(process.execPath, "../../..");
  const canUpdate = source !== null && environment.isPackaged && appBundle.endsWith(".app");
  const logPath = environment.path.join(environment.logDir, "source-update.log");

  const stateRef = yield* Ref.make<DesktopUpdateState>({
    ...createInitialDesktopUpdateState(environment.appVersion, environment.runtimeInfo, "nightly"),
    enabled: canUpdate,
    status: canUpdate ? "idle" : "disabled",
    message: canUpdate ? null : "This build does not know its source checkout.",
  });
  const changes = yield* PubSub.sliding<DesktopUpdateState>(16);
  const busyRef = yield* Ref.make(false);

  const setState = (patch: Partial<DesktopUpdateState>) =>
    Ref.updateAndGet(stateRef, (state) => ({ ...state, ...patch })).pipe(
      Effect.tap((state) => PubSub.publish(changes, state)),
      Effect.tap((state) => electronWindow.sendAll(IpcChannels.UPDATE_STATE_CHANNEL, state)),
    );
  const report = (patch: Partial<DesktopUpdateState>) => runPromise(setState(patch));
  const pendingPlanRef = yield* Ref.make<Option.Option<UpdatePlan>>(Option.none());
  const builtVersionRef = yield* Ref.make<Option.Option<string>>(Option.none());

  const showConflict = async (conflict: MergeConflict) => {
    const { response } = await Electron.dialog.showMessageBox({
      type: "warning",
      title: "Update needs a manual merge",
      message: `${conflict.tag} conflicts with your Kaluwa changes.`,
      detail: `Nothing was changed: the merge was cancelled.\n\nConflicting files:\n${
        conflict.files.length > 0
          ? conflict.files.map((file) => `• ${file}`).join("\n")
          : "(none listed)"
      }\n\nCopy the full report and give it to an agent working in the checkout to resolve it.`,
      buttons: ["Copy for Agent", "Close"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) Electron.clipboard.writeText(conflict.report);
  };

  const buildUpdate = async (plan: UpdatePlan): Promise<string> => {
    if (source === null)
      throw new SourceUpdateError("This build does not know its source checkout.");
    const run = makeRunner(source.repoRoot, logPath);
    const step = (downloadPercent: number, message: string) =>
      report({ status: "downloading", downloadPercent, message, errorContext: null });

    if (plan.merge) {
      await step(5, `Merging ${plan.tag}…`);
      const merge = await run(
        `git merge --no-edit -m "Merge nightly ${plan.tag} into custom" ${plan.tag}`,
      );
      if (merge.code !== 0) {
        const conflict = await describeConflict(run, source.repoRoot, plan.tag, merge.output);
        await run("git merge --abort");
        void showConflict(conflict);
        throw new SourceUpdateError(
          `${plan.tag} conflicts with your changes. Copy the report from the dialog to resolve it.`,
        );
      }
    }
    await step(15, "Installing dependencies…");
    if ((await run("vp i")).code !== 0) {
      throw new SourceUpdateError("Installing dependencies failed. See source-update.log.");
    }
    await step(25, "Building Kaluwa in the background…");
    const buildVersion = `${
      (
        JSON.parse(
          NodeFS.readFileSync(NodePath.join(source.repoRoot, "apps/server/package.json"), "utf8"),
        ) as { version: string }
      ).version
    }-local`;
    const zipPath = NodePath.join(source.repoRoot, "release", `T3-Code-${buildVersion}-arm64.zip`);
    NodeFS.rmSync(zipPath, { force: true });
    const build = await run(`vp run dist:desktop:dmg:arm64 --build-version ${buildVersion}`);
    if (build.code !== 0 || !NodeFS.existsSync(zipPath)) {
      throw new SourceUpdateError("The build failed. See source-update.log.");
    }
    await step(90, "Preparing the new build…");
    const stagingDir = NodePath.join(NodePath.dirname(appBundle), STAGING_DIR);
    NodeFS.rmSync(stagingDir, { recursive: true, force: true });
    NodeFS.mkdirSync(stagingDir, { recursive: true });
    const unzip = await run(`ditto -x -k '${zipPath}' '${stagingDir}'`);
    if (unzip.code !== 0 || !NodeFS.existsSync(NodePath.join(stagingDir, "Kaluwa.app"))) {
      throw new SourceUpdateError("Could not unpack the new build. See source-update.log.");
    }
    return plan.tag.replace(/^v/, "");
  };

  const check = Effect.fn("LocalSourceUpdates.check")(function* () {
    if (source === null || !canUpdate) {
      return { checked: false, state: yield* Ref.get(stateRef) };
    }
    const current = yield* Ref.get(stateRef);
    if (
      (yield* Ref.getAndSet(busyRef, true)) ||
      current.status === "downloading" ||
      current.status === "downloaded"
    ) {
      if (current.status !== "checking") yield* Ref.set(busyRef, current.status === "downloading");
      return { checked: true, state: current };
    }
    yield* setState({ status: "checking", message: null, errorContext: null });
    const run = makeRunner(source.repoRoot, logPath);
    const planned = yield* Effect.promise(() =>
      planUpdate(run, source.commit).then(
        (plan) => ({ ok: true as const, plan }),
        (error: unknown) => ({
          ok: false as const,
          message: error instanceof SourceUpdateError ? error.message : "The update check failed.",
        }),
      ),
    );
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (!planned.ok) {
      yield* Ref.set(busyRef, false);
      const state = yield* setState({
        status: "error",
        errorContext: "check",
        message: planned.message,
        canRetry: true,
        checkedAt,
      });
      return { checked: false, state };
    }
    if (planned.plan.kind === "up-to-date") {
      yield* Ref.set(busyRef, false);
      yield* Ref.set(pendingPlanRef, Option.none());
      const state = yield* setState({
        status: "up-to-date",
        availableVersion: null,
        releaseNotes: [],
        omittedReleaseCount: 0,
        message: null,
        checkedAt,
      });
      return { checked: true, state };
    }
    const plan = planned.plan;
    const version = plan.tag.replace(/^v/, "");
    const notes = yield* Effect.promise(() => fetchReleaseNotes(plan.newTags));
    const { releaseNotes, omittedReleaseCount } = normalizeDesktopUpdateReleaseNotes(
      notes.entries,
      version,
      "nightly",
      notes.releasedAt,
    );
    yield* Ref.set(pendingPlanRef, Option.some(plan));
    yield* Ref.set(busyRef, false);
    const state = yield* setState({
      status: "available",
      availableVersion: version,
      releaseNotes,
      omittedReleaseCount,
      downloadPercent: null,
      message: null,
      errorContext: null,
      checkedAt,
    });
    return { checked: true, state };
  });

  const download = Effect.gen(function* () {
    const plan = yield* Ref.get(pendingPlanRef);
    if (Option.isNone(plan) || (yield* Ref.getAndSet(busyRef, true))) {
      return { accepted: false, completed: false, state: yield* Ref.get(stateRef) };
    }
    yield* setState({
      status: "downloading",
      downloadPercent: 0,
      message: null,
      errorContext: null,
    });
    const outcome = yield* Effect.promise(() =>
      buildUpdate(plan.value).then(
        (version) => ({ ok: true as const, version }),
        (error: unknown) => ({
          ok: false as const,
          message:
            error instanceof SourceUpdateError
              ? error.message
              : "The update failed. See source-update.log.",
        }),
      ),
    );
    yield* Ref.set(busyRef, false);
    if (!outcome.ok) {
      const state = yield* setState({
        status: "error",
        errorContext: "download",
        message: outcome.message,
        canRetry: true,
        downloadPercent: null,
      });
      return { accepted: true, completed: false, state };
    }
    yield* Ref.set(pendingPlanRef, Option.none());
    yield* Ref.set(builtVersionRef, Option.some(outcome.version));
    const state = yield* setState({
      status: "downloaded",
      downloadedVersion: outcome.version,
      downloadPercent: 100,
      message: null,
    });
    return { accepted: true, completed: true, state };
  }).pipe(Effect.withSpan("LocalSourceUpdates.download"));

  const install = Effect.gen(function* () {
    if (Option.isNone(yield* Ref.get(builtVersionRef))) {
      return { accepted: false, completed: false, state: yield* Ref.get(stateRef) };
    }
    const staged = NodePath.join(NodePath.dirname(appBundle), STAGING_DIR, "Kaluwa.app");
    const previous = NodePath.join(NodePath.dirname(appBundle), STAGING_DIR, "Kaluwa-previous.app");
    const swapped = yield* Effect.sync(() => {
      try {
        NodeFS.rmSync(previous, { recursive: true, force: true });
        NodeFS.renameSync(appBundle, previous);
        NodeFS.renameSync(staged, appBundle);
        return true;
      } catch {
        return false;
      }
    });
    if (!swapped) {
      const state = yield* setState({
        status: "error",
        errorContext: "install",
        message: "Could not replace Kaluwa.app. See source-update.log.",
        canRetry: true,
      });
      return { accepted: true, completed: false, state };
    }
    yield* Effect.sync(() => {
      Electron.app.relaunch();
      Electron.app.quit();
    });
    return { accepted: true, completed: true, state: yield* Ref.get(stateRef) };
  }).pipe(Effect.withSpan("LocalSourceUpdates.install"));

  return {
    getState: Ref.get(stateRef),
    isActionActive: Ref.get(busyRef),
    isInstallActive: Effect.succeed(false),
    subscribe: Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(changes);
      return { latest: yield* Ref.get(stateRef), changes: Stream.fromSubscription(subscription) };
    }),
    emitState: Ref.get(stateRef).pipe(
      Effect.flatMap((state) => electronWindow.sendAll(IpcChannels.UPDATE_STATE_CHANNEL, state)),
    ),
    disabledReason: Effect.succeed(
      canUpdate
        ? Option.none<string>()
        : Option.some("This build does not know its source checkout."),
    ),
    configure: Effect.void,
    setChannel: () => Ref.get(stateRef),
    check: () => check(),
    download,
    install,
    installPrepared: () =>
      Ref.get(stateRef).pipe(
        Effect.map((state) => ({ accepted: false, completed: false, failed: true, state })),
      ),
  };
});
