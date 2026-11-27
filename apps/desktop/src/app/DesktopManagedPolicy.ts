// @effect-diagnostics nodeBuiltinImport:off - pre-ready managed policy evaluation must complete synchronously before Electron registers privileged schemes.
/**
 * DesktopManagedPolicy - the administrator's managed policy as the desktop app reads it, at most
 * once: every desktop check needs the same answer.
 *
 * @module DesktopManagedPolicy
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import type { ManagedPolicyDocument } from "@t3tools/contracts";
import {
  layerWindowsRegistry,
  ManagedPolicyFileError,
  readManagedPolicy,
  WindowsRegistry,
} from "@t3tools/shared/managedPolicyFile";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const PLUTIL = "/usr/bin/plutil";

const runPlutilSync = (path: string) =>
  Effect.try({
    try: () => {
      const result = NodeChildProcess.spawnSync(PLUTIL, ["-convert", "json", "-o", "-", path], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000,
      });
      if (result.error) throw result.error;
      return {
        stdout: result.stdout ?? "",
        exitCode: result.status ?? 1,
      };
    },
    catch: (cause) =>
      new ManagedPolicyFileError({ path, reason: "the profile cannot be read", cause }),
  });

const loadFfiSync = (): typeof import("ffi-rs") => {
  if (typeof require === "function") {
    return require("ffi-rs") as typeof import("ffi-rs");
  }
  return NodeModule.createRequire(import.meta.url)("ffi-rs") as typeof import("ffi-rs");
};

type FoundPolicy = Effect.Success<ReturnType<typeof readManagedPolicy>>;
const isManagedPolicyFileError = Schema.is(ManagedPolicyFileError);

export class DesktopManagedPolicy extends Context.Service<
  DesktopManagedPolicy,
  {
    /** The policy on this machine, undefined without one; fails when it cannot be used. */
    readonly read: Effect.Effect<FoundPolicy, ManagedPolicyFileError>;
  }
>()("@t3tools/desktop/app/DesktopManagedPolicy") {}

export const layer = Layer.effect(
  DesktopManagedPolicy,
  Effect.gen(function* () {
    const { platform } = yield* DesktopEnvironment.DesktopEnvironment;
    const read = yield* Effect.cached(
      readManagedPolicy(platform, [], { runPlutil: runPlutilSync }).pipe(
        Effect.provideService(FileSystem.FileSystem, yield* FileSystem.FileSystem),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          yield* ChildProcessSpawner.ChildProcessSpawner,
        ),
        Effect.provideService(WindowsRegistry, yield* WindowsRegistry),
      ),
    );
    return DesktopManagedPolicy.of({ read });
  }),
).pipe(Layer.provide(layerWindowsRegistry(loadFfiSync)));

/** Whether the managed policy allows T3 Connect; fails closed if the policy cannot be used. */
export const isConnectAllowed = Effect.fn("desktop.managedPolicy.isConnectAllowed")(function* () {
  return yield* (yield* DesktopManagedPolicy).read.pipe(
    Effect.map((found) => found?.document.limits?.connect !== false),
    Effect.orElseSucceed(() => false),
  );
});

/** A machine with `policy` deployed, one whose policy cannot be used, or none. */
export const layerTest = (policy?: ManagedPolicyDocument | ManagedPolicyFileError) =>
  Layer.succeed(
    DesktopManagedPolicy,
    DesktopManagedPolicy.of({
      read:
        policy === undefined
          ? Effect.undefined
          : isManagedPolicyFileError(policy)
            ? Effect.fail(policy)
            : Effect.succeed({ source: "/test/policy.json", document: policy }),
    }),
  );
