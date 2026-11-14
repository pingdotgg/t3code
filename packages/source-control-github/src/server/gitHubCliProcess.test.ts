import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";

import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import { makeGhProcess } from "./gitHubCliProcess.ts";

function spawnedBusAddress(input: {
  readonly platform?: NodeJS.Platform;
  readonly address?: string;
  readonly spawnAddress?: string;
  /** File contents by path; a path not listed does not exist. */
  readonly files?: Readonly<Record<string, string>>;
  /** A path that exists but cannot be stat'ed or read. */
  readonly unreadable?: string;
}) {
  const files = input.files ?? {};
  const denied = (path: string, method: string) =>
    Effect.fail(
      PlatformError.systemError({
        _tag: path === input.unreadable ? "PermissionDenied" : "NotFound",
        module: "FileSystem",
        method,
        pathOrDescriptor: path,
      }),
    );
  const envs: Array<NodeJS.ProcessEnv | undefined> = [];
  const run: SourceControlHost.SourceControlHost["Service"]["process"]["run"] = (spawn) =>
    Effect.sync(() => {
      envs.push(spawn.env);
      return {
        exitCode: ChildProcessSpawner.ExitCode(0),
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    });
  return Effect.gen(function* () {
    const gh = yield* makeGhProcess;
    yield* gh.run({
      operation: "test",
      command: "gh",
      args: ["auth", "status"],
      cwd: "/",
      ...(input.spawnAddress === undefined
        ? {}
        : { env: { DBUS_SESSION_BUS_ADDRESS: input.spawnAddress } }),
    });
    return envs[0]?.DBUS_SESSION_BUS_ADDRESS;
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        TestSourceControlHost.layer({ process: { run } }),
        FileSystem.layerNoop({
          exists: (path) =>
            path === input.unreadable ? denied(path, "exists") : Effect.succeed(path in files),
          readFileString: (path) =>
            path in files ? Effect.succeed(files[path]!) : denied(path, "readFileString"),
        }),
      ),
    ),
    Effect.provideService(HostProcess.Platform, input.platform ?? "linux"),
    Effect.provideService(HostProcess.UserId, 1000),
    Effect.provideService(
      HostProcess.Environment,
      input.address === undefined ? {} : { DBUS_SESSION_BUS_ADDRESS: input.address },
    ),
  );
}

describe("makeGhProcess", () => {
  it.effect("turns the bus off when godbus would have to autolaunch one", () =>
    Effect.gen(function* () {
      expect(yield* spawnedBusAddress({})).toBe("disabled:");
      expect(yield* spawnedBusAddress({ address: "autolaunch:" })).toBe("disabled:");
      expect(yield* spawnedBusAddress({ spawnAddress: "autolaunch:" })).toBe("disabled:");
      // A spawn that clears the host's address leaves godbus nothing to use either.
      expect(yield* spawnedBusAddress({ address: "unix:path=/tmp/bus", spawnAddress: "" })).toBe(
        "disabled:",
      );
      // godbus ignores a `dbus-session` file it cannot read or that names no address.
      const session = "/run/user/1000/dbus-session";
      expect(yield* spawnedBusAddress({ unreadable: session })).toBe("disabled:");
      expect(yield* spawnedBusAddress({ files: { [session]: "garbage\n" } })).toBe("disabled:");
      expect(
        yield* spawnedBusAddress({ files: { [session]: "DBUS_SESSION_BUS_ADDRESS=\r\n" } }),
      ).toBe("disabled:");
    }),
  );

  it.effect("leaves a bus godbus can find or was given", () =>
    Effect.gen(function* () {
      expect(yield* spawnedBusAddress({ files: { "/run/user/1000/bus": "" } })).toBeUndefined();
      expect(
        yield* spawnedBusAddress({
          files: {
            "/run/user/1000/dbus-session": "DBUS_SESSION_BUS_ADDRESS=unix:abstract=/tmp/dbus-x\n",
          },
        }),
      ).toBeUndefined();
      expect(yield* spawnedBusAddress({ address: "unix:path=/tmp/bus" })).toBeUndefined();
      expect(yield* spawnedBusAddress({ spawnAddress: "unix:path=/tmp/bus" })).toBe(
        "unix:path=/tmp/bus",
      );
      expect(yield* spawnedBusAddress({ platform: "darwin" })).toBeUndefined();
      // godbus counts a socket it cannot stat as present, so an unreadable one is left alone too.
      expect(yield* spawnedBusAddress({ unreadable: "/run/user/1000/bus" })).toBeUndefined();
    }),
  );
});
