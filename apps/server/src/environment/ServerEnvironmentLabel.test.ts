import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import { resolveServerEnvironmentLabel } from "./ServerEnvironmentLabel.ts";

const resolveLinuxLabel = (input: {
  readonly kernelRelease: string;
  readonly env: NodeJS.ProcessEnv;
}) =>
  resolveServerEnvironmentLabel({ cwdBaseName: "project" }).pipe(
    Effect.provideService(
      ProcessRunner.ProcessRunner,
      ProcessRunner.ProcessRunner.of({
        run: () =>
          Effect.succeed({
            stdout: "",
            stderr: "",
            code: ChildProcessSpawner.ExitCode(1),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          }),
      }),
    ),
    Effect.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({
          exists: () => Effect.succeed(false),
          readFileString: (path) =>
            path === "/proc/sys/kernel/osrelease"
              ? Effect.succeed(input.kernelRelease)
              : Effect.die(`unexpected read: ${path}`),
        }),
        Layer.succeed(HostProcess.Platform, "linux"),
        Layer.succeed(HostProcess.Hostname, "DESKTOP-PC"),
        Layer.succeed(HostProcess.Environment, input.env),
      ),
    ),
  );

it.effect("labels a WSL server with its host and distro", () =>
  Effect.gen(function* () {
    const label = yield* resolveLinuxLabel({
      kernelRelease: "6.6.87.2-microsoft-standard-WSL2\n",
      env: { WSL_DISTRO_NAME: "Ubuntu" },
    });
    expect(label).toBe("DESKTOP-PC WSL (Ubuntu)");
  }),
);

it.effect("labels a WSL server without a distro name by its host", () =>
  Effect.gen(function* () {
    const label = yield* resolveLinuxLabel({
      kernelRelease: "6.6.87.2-microsoft-standard-WSL2\n",
      env: {},
    });
    expect(label).toBe("DESKTOP-PC WSL");
  }),
);

it.effect("keeps the hostname for non-WSL Linux", () =>
  Effect.gen(function* () {
    const label = yield* resolveLinuxLabel({
      kernelRelease: "6.8.0-45-generic\n",
      env: { WSL_DISTRO_NAME: "Ubuntu" },
    });
    expect(label).toBe("DESKTOP-PC");
  }),
);
