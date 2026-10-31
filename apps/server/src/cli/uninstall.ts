// @effect-diagnostics nodeBuiltinImport:off
// Windows cleanup must outlive this executable to delete its directory; scoped ChildProcess kills children on exit.
import * as NodeChildProcess from "node:child_process";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { replaceOwnedLink } from "@t3tools/shared/ownedLink";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag, Prompt } from "effect/cli";

import * as BootService from "../cloud/bootService.ts";
import {
  directLinkTargets,
  generatedWindowsShimTarget,
  isVersionExecutable,
  pinnedRuntimeVersionsDir,
} from "../cloud/pinnedRuntime.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import * as CliService from "./service.ts";
import { findWindowsShim, resolveLauncherPath } from "./update.ts";

export class CliUninstallError extends Schema.TaggedError<CliUninstallError>()(
  "CliUninstallError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export interface UninstallPlan {
  readonly service: boolean;
  readonly versionsDir: string;
  readonly launchers: ReadonlyArray<string>;
  readonly runtimeDir: string | undefined;
  readonly userdataDir: string;
}

/** Delete only launchers targeting this home's runtime/versions. */
export const findOwnedLauncher = Effect.fn("cli.uninstall.find_launcher")(function* (input: {
  readonly launchedAs: string | undefined;
  readonly versionsDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  if (input.launchedAs === undefined) return undefined;
  if (platform === "win32") {
    const shimPath = yield* findWindowsShim(input.launchedAs);
    if (shimPath === undefined) return undefined;
    const contents = yield* fs.readFileString(shimPath).pipe(Effect.option);
    const target = Option.isSome(contents) ? generatedWindowsShimTarget(contents.value) : undefined;
    return target !== undefined && isVersionExecutable(path, input.versionsDir, target)
      ? shimPath
      : undefined;
  }
  return (yield* ownsLauncher(input.launchedAs, input.versionsDir)) ? input.launchedAs : undefined;
});

/** Whether `launcher` is a link to this home's command link or a version, or an unedited `t3.cmd`. */
const ownsLauncher = Effect.fn("cli.uninstall.owns_launcher")(function* (
  launcher: string,
  versionsDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const realVersionsDir = yield* fs
    .realPath(versionsDir)
    .pipe(Effect.orElseSucceed(() => versionsDir));
  // Only a direct link counts: a chain through another tool's link is theirs.
  const targets =
    platform === "win32"
      ? [
          yield* fs.readFileString(launcher).pipe(
            Effect.map(generatedWindowsShimTarget),
            Effect.orElseSucceed(() => undefined),
          ),
        ]
      : yield* directLinkTargets(launcher);
  // The command link sits beside versions; a link to it may dangle after a prune.
  const commandLinks = [versionsDir, realVersionsDir].map((dir) =>
    path.join(path.dirname(dir), "t3"),
  );
  return targets.some(
    (target) =>
      target !== undefined &&
      (isVersionExecutable(path, versionsDir, target) ||
        isVersionExecutable(path, realVersionsDir, target) ||
        (platform !== "win32" && commandLinks.includes(target))),
  );
});

/**
 * Launchers recorded in `runtime/launchers` by the install scripts and `t3 install` that still
 * point into this home's runtime/versions. npx can run a different version than the installed
 * one, so the launcher this process started from does not always name them.
 */
export const findRecordedLaunchers = Effect.fn("cli.uninstall.find_recorded_launchers")(function* (
  versionsDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const recorded = yield* fs
    .readFileString(path.join(path.dirname(versionsDir), "launchers"))
    .pipe(Effect.orElseSucceed(() => ""));
  const owned: Array<string> = [];
  for (const launcher of recorded.split(/\r?\n/).filter(Boolean)) {
    if (yield* ownsLauncher(launcher, versionsDir)) owned.push(launcher);
  }
  return owned;
});

// cmd.exe needs verbatim quoting and a literal path, with delayed expansion disabled.
export function spawnWindowsRemoval(comspec: string, dir: string) {
  return NodeChildProcess.spawn(
    comspec,
    [
      "/d",
      "/v:off",
      "/s",
      "/c",
      '"ping -n 3 127.0.0.1 >nul & rmdir /s /q "%T3_UNINSTALL_RUNTIME%""',
    ],
    {
      env: { ...process.env, T3_UNINSTALL_RUNTIME: dir },
      windowsVerbatimArguments: true,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  );
}

const planUninstall = Effect.fn("cli.uninstall.plan")(function* (input: {
  readonly baseDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const service = yield* BootService.BootService;
  const status = yield* service.status;
  const servesThisHome =
    status.installedBaseDir !== undefined &&
    path.resolve(status.installedBaseDir) === path.resolve(input.baseDir);
  const versionsDir = pinnedRuntimeVersionsDir(path, input.baseDir);
  const runtimeDir = path.dirname(versionsDir);
  const launchedAs = (yield* HostProcess.IsExecutable) ? yield* resolveLauncherPath : undefined;
  const launchedFrom = yield* findOwnedLauncher({ launchedAs, versionsDir });
  const plan: UninstallPlan = {
    service: status.supported && status.installed && servesThisHome,
    versionsDir,
    launchers: [
      ...new Set([
        ...(launchedFrom === undefined ? [] : [launchedFrom]),
        ...(yield* findRecordedLaunchers(versionsDir)),
      ]),
    ],
    runtimeDir: (yield* fs.exists(runtimeDir).pipe(Effect.orElseSucceed(() => false)))
      ? runtimeDir
      : undefined,
    userdataDir: path.join(input.baseDir, "userdata"),
  };
  return plan;
});

export const uninstallCommand = Command.make("uninstall", {
  ...projectLocationFlags,
  yes: Flag.Boolean("yes").pipe(
    Flag.withAlias("y"),
    Flag.withDescription(
      "Remove everything without asking. Required from a script, where there is no prompt.",
    ),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Remove t3 from this machine: the background service, the launcher, and every downloaded version. Your projects and threads are kept.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);
      return yield* runUninstall({ baseDir: config.baseDir, assumeYes: flags.yes }).pipe(
        Effect.provide(CliService.layer(config)),
      );
    }),
  ),
);

const runUninstall = Effect.fn("cli.uninstall.run")(function* (input: {
  readonly baseDir: string;
  readonly assumeYes: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const service = yield* BootService.BootService;
  const plan = yield* planUninstall({ baseDir: input.baseDir });

  if (!plan.service && plan.launchers.length === 0 && plan.runtimeDir === undefined) {
    yield* Console.log(`Nothing to remove: t3 is not installed for ${input.baseDir}.`);
    if (!(yield* HostProcess.IsExecutable)) {
      yield* Console.log(
        "  This t3 runs from a Node script, so it was installed by npm or built from source. Remove it the same way (`npm uninstall -g t3`, or delete the checkout).",
      );
    }
    return;
  }

  yield* Console.log("This will remove:");
  if (plan.service) yield* Console.log("  the background service (stopping it first)");
  for (const launcher of plan.launchers) yield* Console.log(`  the launcher at ${launcher}`);
  if (plan.runtimeDir !== undefined) {
    yield* Console.log(`  every downloaded version under ${plan.runtimeDir}`);
  }
  yield* Console.log(
    `Your projects, threads, and settings under ${plan.userdataDir} are kept. Delete that directory yourself if you want them gone too.`,
  );

  if (!input.assumeYes) {
    if (!(process.stdin.isTTY && process.stdout.isTTY)) {
      return yield* new CliUninstallError({
        reason:
          "Not a terminal, so nothing was removed. Rerun with --yes to confirm from a script.",
      });
    }
    const confirmed = yield* Prompt.run(
      Prompt.Confirm({ message: "Remove t3 from this machine?", initial: false }),
    ).pipe(Effect.catchTags({ QuitError: () => Effect.succeed(false) }));
    if (!confirmed) {
      yield* Console.log("Left as is.");
      return;
    }
  }

  if (plan.service) {
    yield* service.uninstall;
    yield* Console.log("Removed the background service.");
  }
  for (const launcher of plan.launchers) {
    // The prompt can wait a long time; never delete a file that replaced the launcher meanwhile.
    const owns = (candidate: string) => ownsLauncher(candidate, plan.versionsDir);
    // Windows keeps the checked removal; its shims are out of the moved-aside swap.
    const removed =
      (yield* owns(launcher)) &&
      (yield* (
        platform === "win32"
          ? fs.remove(launcher, { force: true }).pipe(Effect.as(true))
          : replaceOwnedLink({ link: launcher, owns })
      ).pipe(
        Effect.mapError(
          () => new CliUninstallError({ reason: `Could not remove the launcher at ${launcher}.` }),
        ),
      ));
    if (!removed) {
      yield* Console.log(`Left ${launcher}: it no longer runs this t3.`);
      continue;
    }
    yield* Console.log(`Removed ${launcher}.`);
  }
  if (plan.runtimeDir !== undefined) {
    // Windows refuses to unlink this running executable; a detached shell removes it after exit.
    if (platform === "win32") {
      const runtimeDir = plan.runtimeDir;
      const comspec = environment["ComSpec"] ?? environment["COMSPEC"] ?? "cmd.exe";
      yield* Effect.try({
        try: () => spawnWindowsRemoval(comspec, runtimeDir).unref(),
        catch: () =>
          new CliUninstallError({
            reason: `Could not schedule removal of ${runtimeDir}. Delete it yourself once this window is closed.`,
          }),
      });
      yield* Console.log(`${runtimeDir} will be removed once t3 exits.`);
    } else {
      yield* fs
        .remove(plan.runtimeDir, { recursive: true, force: true })
        .pipe(
          Effect.mapError(
            () => new CliUninstallError({ reason: `Could not remove ${plan.runtimeDir}.` }),
          ),
        );
      yield* Console.log(`Removed ${plan.runtimeDir}.`);
    }
  }
  yield* Console.log("");
  yield* Console.log("t3 is uninstalled. Thanks for trying T3 Code.");
});
