import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import type * as sharedShell from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import * as Shells from "./shells.ts";

const isCommandAvailable = vi.hoisted(() => vi.fn());
vi.mock("@t3tools/shared/shell", async (importOriginal) => ({
  ...(await importOriginal<typeof sharedShell>()),
  isCommandAvailable,
}));

const baseEnv: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };

function layer(platform: NodeJS.Platform) {
  return Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(HostProcessPlatform, platform),
    Layer.succeed(HostProcessEnvironment, baseEnv),
  );
}

function listShells(
  platform: NodeJS.Platform,
  options?: Parameters<typeof Shells.listAvailableShells>[0],
) {
  return Shells.listAvailableShells(options).pipe(Effect.provide(layer(platform)));
}

it.effect("posix probes bare command names and falls back to the platform default", () =>
  Effect.gen(function* () {
    const available = new Set(["zsh", "bash"]);
    isCommandAvailable.mockImplementation((command: string) =>
      Effect.succeed(available.has(command)),
    );

    const result = yield* listShells("linux");

    assert.deepEqual(
      result.shells.map((s) => s.executable),
      ["zsh", "bash"],
    );
    assert.equal(result.defaultShell, "/bin/bash");
  }),
);

it.effect("prioritizes the host shell for defaultShell when a resolver is provided", () =>
  Effect.gen(function* () {
    isCommandAvailable.mockImplementation((command: string) => Effect.succeed(command === "zsh"));

    const result = yield* listShells("linux", { resolveDefaultShell: () => "/usr/bin/fish" });

    assert.equal(result.defaultShell, "/usr/bin/fish");
  }),
);

it.effect("trims whitespace from the resolved default shell", () =>
  Effect.gen(function* () {
    isCommandAvailable.mockImplementation((command: string) => Effect.succeed(command === "bash"));

    const result = yield* listShells("linux", { resolveDefaultShell: () => "  /bin/zsh  " });

    assert.equal(result.defaultShell, "/bin/zsh");
  }),
);

it.effect("win32 resolves git bash from its canonical install location", () =>
  Effect.gen(function* () {
    const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
    const available = new Set([gitBash]);
    isCommandAvailable.mockImplementation((command: string) =>
      Effect.succeed(available.has(command)),
    );

    const result = yield* listShells("win32", {
      resolveDefaultShell: () => "cmd.exe",
    });

    assert.equal(result.defaultShell, "cmd.exe");
    const gitBashEntry = result.shells.find((s) => s.id === "git-bash");
    assert.equal(gitBashEntry?.executable, gitBash);
  }),
);
