// @effect-diagnostics nodeBuiltinImport:off -- Fork: the source updater drives git and the build as long-lived shell steps.
// @effect-diagnostics extendsNativeError:off -- Only carries a user-facing message between promise steps.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { DesktopUpdateActionResult, DesktopUpdateState } from "@t3tools/contracts";
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

type Plan =
  | { readonly kind: "up-to-date"; readonly tag: string }
  | { readonly kind: "update"; readonly tag: string; readonly merge: boolean };

class SourceUpdateError extends Error {}

const SHELL_SETUP = 'source "$HOME/.config/vite-plus/env" >/dev/null 2>&1; ';
const FORK_BRANCH = "custom";
const STAGING_DIR = ".kaluwa-update";

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
        output = (output + chunk.toString()).slice(-4000);
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
  return { kind: "update", tag, merge: !merged };
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
  const fail = (context: "check" | "download" | "install", message: string) =>
    report({
      status: "error",
      errorContext: context,
      message,
      canRetry: true,
      downloadPercent: null,
    });

  const installAndRestart = async (version: string) => {
    const staged = NodePath.join(NodePath.dirname(appBundle), STAGING_DIR, "Kaluwa.app");
    const previous = NodePath.join(NodePath.dirname(appBundle), STAGING_DIR, "Kaluwa-previous.app");
    await report({ status: "downloaded", downloadedVersion: version, message: "Restarting…" });
    NodeFS.rmSync(previous, { recursive: true, force: true });
    NodeFS.renameSync(appBundle, previous);
    NodeFS.renameSync(staged, appBundle);
    Electron.app.relaunch();
    Electron.app.quit();
  };

  const buildAndInstall = async (plan: Extract<Plan, { kind: "update" }>) => {
    if (source === null) return;
    const run = makeRunner(source.repoRoot, logPath);
    const version = plan.tag.replace(/^v/, "");
    const step = (downloadPercent: number, message: string) =>
      report({
        status: "downloading",
        availableVersion: version,
        downloadPercent,
        message,
        errorContext: null,
      });

    if (plan.merge) {
      await step(5, `Merging ${plan.tag}…`);
      const merge = await run(
        `git merge --no-edit -m "Merge nightly ${plan.tag} into custom" ${plan.tag}`,
      );
      if (merge.code !== 0) {
        await run("git merge --abort");
        throw new SourceUpdateError(
          `${plan.tag} conflicts with your changes. Merge it by hand, then check again.`,
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
    await installAndRestart(buildVersion);
  };

  const startUpdate = (plan: Extract<Plan, { kind: "update" }>) => {
    void buildAndInstall(plan)
      .catch((error: unknown) =>
        fail(
          "download",
          error instanceof SourceUpdateError
            ? error.message
            : "The update failed. See source-update.log.",
        ),
      )
      .finally(() => runPromise(Ref.set(busyRef, false)));
  };

  const check = Effect.fn("LocalSourceUpdates.check")(function* () {
    if (source === null || !canUpdate) {
      return { checked: false, state: yield* Ref.get(stateRef) };
    }
    if (yield* Ref.getAndSet(busyRef, true)) {
      return { checked: true, state: yield* Ref.get(stateRef) };
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
      const state = yield* setState({
        status: "up-to-date",
        availableVersion: null,
        message: `Up to date with ${planned.plan.tag}.`,
        checkedAt,
      });
      return { checked: true, state };
    }
    const state = yield* setState({
      status: "downloading",
      availableVersion: planned.plan.tag.replace(/^v/, ""),
      downloadPercent: 0,
      message: "Updating from source…",
      checkedAt,
    });
    startUpdate(planned.plan);
    return { checked: true, state };
  });

  const notAccepted: Effect.Effect<DesktopUpdateActionResult> = Ref.get(stateRef).pipe(
    Effect.map((state) => ({ accepted: false, completed: false, state })),
  );

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
    download: notAccepted,
    install: notAccepted,
    installPrepared: () => notAccepted.pipe(Effect.map((result) => ({ ...result, failed: true }))),
  };
});
