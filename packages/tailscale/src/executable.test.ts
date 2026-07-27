import { assert, describe, it } from "@effect/vitest";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

import {
  resolveTailscaleExecutable,
  resolveTailscaleExecutableWith,
  TAILSCALE_CLI_PATH_ENV,
  TailscaleExecutableProbe,
  tailscaleInstallLocations,
} from "./executable.ts";

const MAC_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

const existing = (...paths: ReadonlyArray<string>) => {
  const set = new Set(paths);
  return (candidate: string) => set.has(candidate);
};

describe("tailscale executable discovery", () => {
  it.effect("honours an explicit override verbatim", () =>
    Effect.sync(() => {
      const resolved = resolveTailscaleExecutableWith({
        platform: "darwin",
        env: { [TAILSCALE_CLI_PATH_ENV]: "/opt/custom/tailscale", PATH: "/usr/bin" },
        isExecutable: () => false,
      });

      assert.deepEqual(resolved, { command: "/opt/custom/tailscale", source: "override" });
    }),
  );

  it.effect("prefers a PATH entry over a bundled install", () =>
    Effect.sync(() => {
      const resolved = resolveTailscaleExecutableWith({
        platform: "darwin",
        env: { PATH: "/usr/bin:/opt/homebrew/bin" },
        isExecutable: existing("/opt/homebrew/bin/tailscale", MAC_APP_CLI),
      });

      assert.deepEqual(resolved, { command: "/opt/homebrew/bin/tailscale", source: "path" });
    }),
  );

  // The failure this whole module exists for: a GUI-launched macOS app inherits
  // a PATH with no tailscale in it, while the CLI sits inside Tailscale.app.
  it.effect("finds the macOS CLI inside Tailscale.app when PATH has none", () =>
    Effect.sync(() => {
      const resolved = resolveTailscaleExecutableWith({
        platform: "darwin",
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
        isExecutable: existing(MAC_APP_CLI),
      });

      assert.deepEqual(resolved, { command: MAC_APP_CLI, source: "install-location" });
    }),
  );

  it.effect("finds a user-local Tailscale.app", () =>
    Effect.sync(() => {
      const userCli = "/Users/dev/Applications/Tailscale.app/Contents/MacOS/Tailscale";
      const resolved = resolveTailscaleExecutableWith({
        platform: "darwin",
        env: { PATH: "/usr/bin", HOME: "/Users/dev" },
        isExecutable: existing(userCli),
      });

      assert.deepEqual(resolved, { command: userCli, source: "install-location" });
    }),
  );

  it.effect("falls back to the bare command name when nothing is found", () =>
    Effect.sync(() => {
      assert.deepEqual(
        resolveTailscaleExecutableWith({
          platform: "darwin",
          env: { PATH: "/usr/bin" },
          isExecutable: () => false,
        }),
        { command: "tailscale", source: "not-found" },
      );
      assert.deepEqual(
        resolveTailscaleExecutableWith({
          platform: "win32",
          env: { Path: "C:\\Windows" },
          isExecutable: () => false,
        }),
        { command: "tailscale.exe", source: "not-found" },
      );
    }),
  );

  it.effect("searches Windows PATH and Program Files with backslashes", () =>
    Effect.sync(() => {
      const installed = "C:\\Program Files\\Tailscale\\tailscale.exe";
      const resolved = resolveTailscaleExecutableWith({
        platform: "win32",
        env: { Path: "C:\\Windows;C:\\Windows\\System32", ProgramFiles: "C:\\Program Files" },
        isExecutable: existing(installed),
      });

      assert.deepEqual(resolved, { command: installed, source: "install-location" });
      assert.include(tailscaleInstallLocations("win32", {}), installed);
    }),
  );

  it.effect("skips empty PATH segments", () =>
    Effect.sync(() => {
      const resolved = resolveTailscaleExecutableWith({
        platform: "linux",
        env: { PATH: ":/usr/local/bin:" },
        isExecutable: existing("/usr/local/bin/tailscale"),
      });

      assert.deepEqual(resolved, { command: "/usr/local/bin/tailscale", source: "path" });
    }),
  );

  it.effect("resolves through the host process references", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveTailscaleExecutable.pipe(
        Effect.provideService(HostProcessPlatform, "darwin"),
        Effect.provideService(HostProcessEnvironment, { PATH: "/usr/bin" }),
        Effect.provideService(TailscaleExecutableProbe, existing(MAC_APP_CLI)),
      );

      assert.deepEqual(resolved, { command: MAC_APP_CLI, source: "install-location" });
    }),
  );
});
