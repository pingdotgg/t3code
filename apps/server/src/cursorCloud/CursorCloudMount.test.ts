import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { CursorCloudError, ThreadId } from "@t3tools/contracts";
import {
  RemoteCallError,
  type CursorCloudMachineApi,
} from "@t3tools/provider-cursor/server/cloudMachine";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as CursorCloudMount from "./CursorCloudMount.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const THREAD = "thread-1";
const MOUNT = `/.t3-cursor-cloud/${THREAD}`;

function fixture(options: { readonly asleep?: boolean } = {}) {
  const execs: Array<Parameters<CursorCloudMachineApi["exec"]>[0]> = [];
  const machine = {
    exec: async (input) => {
      execs.push(input);
      return { exitCode: 0, stdout: encode("/workspace\n"), stderr: new Uint8Array() };
    },
    stat: async (path) => {
      if (path === "/workspace") return { type: "Directory", size: 4096, mtime: 0 };
      throw new RemoteCallError({
        message: `ENOENT: ${path}`,
        remoteName: "EntryNotFound (FileSystemError)",
      });
    },
  } as Pick<CursorCloudMachineApi, "exec" | "stat"> as CursorCloudMachineApi;
  const layer = Layer.effectDiscard(
    Effect.gen(function* () {
      const mount = yield* CursorCloudMount.CursorCloudMount;
      yield* mount.register({
        machine: (threadId, { wake }) =>
          threadId !== ThreadId.make(THREAD) || (options.asleep === true && !wake)
            ? Effect.fail(new CursorCloudError({ reason: "asleep" }))
            : Effect.succeed(machine),
      });
    }),
  ).pipe(Layer.provideMerge(CursorCloudMount.layer), Layer.provide(NodeServices.layer));
  return { execs, layer };
}

describe("CursorCloudMount", () => {
  it.effect("runs `git -C <mount>` on the VM with VM paths, and maps printed paths back", () => {
    const { execs, layer } = fixture();
    return Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const stdout = yield* spawner.string(
        ChildProcess.make("/opt/homebrew/bin/git", ["-C", MOUNT, "rev-parse", "--show-toplevel"], {
          cwd: "/",
          // The host's GIT_CONFIG numbering refers to entries the VM never receives.
          env: {
            GIT_CONFIG_COUNT: "2",
            GIT_CONFIG_KEY_1: "x",
            GIT_OPTIONAL_LOCKS: "0",
            HOME: "/h",
          },
        }),
      );

      expect(stdout).toBe(`${MOUNT}\n`);
      expect(execs).toEqual([
        {
          command: "git",
          args: ["-C", "/workspace", "rev-parse", "--show-toplevel"],
          cwd: "/workspace",
          env: { GIT_OPTIONAL_LOCKS: "0" },
        },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("sends stdin a caller writes while reading output", () => {
    const { execs, layer } = fixture();
    return Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner.spawn(
        ChildProcess.make("git", ["check-ignore", "-z", "--stdin"], { cwd: `${MOUNT}/apps` }),
      );
      yield* Effect.all(
        [Stream.runDrain(handle.stdout), Stream.run(Stream.make(encode("a\0b\0")), handle.stdin)],
        { concurrency: "unbounded" },
      );

      expect(execs[0]?.cwd).toBe("/workspace/apps");
      expect(execs[0]?.stdin).toEqual(encode("a\0b\0"));
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("reports VM files through the host FileSystem errors callers branch on", () => {
    const { layer } = fixture();
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;

      expect((yield* fileSystem.stat(MOUNT)).type).toBe("Directory");
      expect(yield* fileSystem.exists(`${MOUNT}/missing`)).toBe(false);
      expect(yield* fileSystem.exists("/")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not wake a sleeping VM for file reads", () => {
    const { layer } = fixture({ asleep: true });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const error = yield* fileSystem.stat(MOUNT).pipe(Effect.flip);

      expect(error.reason._tag).toBe("Unknown");
      expect(error.message).toContain("asleep");
    }).pipe(Effect.provide(layer));
  });
});
