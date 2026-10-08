import { describe, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import * as PreviewBrowserHost from "./PreviewBrowserHost.ts";

// What `ldd` printed for the pinned headless shell in a bare debian:trixie-slim container.
const LDD_IN_BARE_DEBIAN = `\tlinux-vdso.so.1 (0x00007ffd2d1f8000)
\tlibdl.so.2 => /lib/x86_64-linux-gnu/libdl.so.2 (0x00007f0c1b6a1000)
\tlibglib-2.0.so.0 => not found
\tlibnss3.so => not found
\tlibX11.so.6 => not found
\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f0c1b4c0000)
`;

// Chrome's own abort on Ubuntu 26.04 with unprivileged user namespaces restricted.
const SANDBOX_ABORT =
  "[1005/163106.285700:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:129] No usable sandbox! If you are running on Ubuntu 23.10+ or another Linux distro that has disabled unprivileged user namespaces with AppArmor, see https://chromium.googlesource.com/";

const lddReporting = (stdout: string) => {
  const commands: Array<string> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      const { command: name, args } = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      commands.push([name, ...args].join(" "));
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode(stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { spawner, commands };
};

const diagnose = (input: { platform: NodeJS.Platform; output: string; ldd: string }) => {
  const { spawner, commands } = lddReporting(input.ldd);
  return PreviewBrowserHost.diagnoseLaunchFailure({
    executable: "/home/me/.t3/tools/chrome-headless-shell/linux64/154/chrome-headless-shell",
    output: input.output,
    setupCommand: "sudo t3 browser setup",
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(HostProcessPlatform, input.platform),
    Effect.map((error) => ({ error, commands })),
  );
};

describe("diagnoseLaunchFailure", () => {
  it.effect("turns Chrome's sandbox abort into the AppArmor steps", () =>
    Effect.gen(function* () {
      const { error, commands } = yield* diagnose({
        platform: "linux",
        output: SANDBOX_ABORT,
        ldd: "",
      });
      expect(error?._tag).toBe("PreviewBrowserSandboxError");
      expect(error?.message).toContain("Run `sudo t3 browser setup` on the host");
      expect(commands).toEqual([]);
    }),
  );

  it.effect("names every library the loader cannot find", () =>
    Effect.gen(function* () {
      const { error } = yield* diagnose({
        platform: "linux",
        output: "error while loading shared libraries: libglib-2.0.so.0",
        ldd: LDD_IN_BARE_DEBIAN,
      });
      expect(error).toMatchObject({
        _tag: "PreviewBrowserLibrariesError",
        libraries: ["libglib-2.0.so.0", "libnss3.so", "libX11.so.6"],
      });
      expect(error?.message).toContain("Run `sudo t3 browser setup` on the host");
    }),
  );

  it.effect("leaves other failures alone", () =>
    Effect.gen(function* () {
      const linux = yield* diagnose({
        platform: "linux",
        output: "crashed",
        ldd: "\tlibc.so.6 => /lib/libc.so.6\n",
      });
      expect(linux.error).toBeUndefined();
      const mac = yield* diagnose({ platform: "darwin", output: "crashed", ldd: "" });
      expect(mac.error).toBeUndefined();
      expect(mac.commands).toEqual([]);
    }),
  );
});
