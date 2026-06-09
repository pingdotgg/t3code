import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { ChildProcessSpawner } from "effect/unstable/process";
import { GrokSettings } from "@t3tools/contracts";

import { buildInitialGrokProviderSnapshot, checkGrokProviderStatus } from "./GrokProvider.ts";

const decodeGrokSettings = Schema.decodeSync(GrokSettings);

const runNode = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

describe("buildInitialGrokProviderSnapshot", () => {
  it("returns a disabled snapshot when settings.enabled is false", async () => {
    const snapshot = await Effect.runPromise(
      buildInitialGrokProviderSnapshot(decodeGrokSettings({ enabled: false })),
    );
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.status).toBe("disabled");
    expect(snapshot.installed).toBe(false);
    expect(snapshot.message).toContain("disabled");
  });

  it("returns a pending snapshot by default", async () => {
    const snapshot = await Effect.runPromise(
      buildInitialGrokProviderSnapshot(decodeGrokSettings({})),
    );
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.installed).toBe(true);
    expect(snapshot.status).toBe("warning");
    expect(snapshot.version).toBeNull();
    expect(snapshot.message).toContain("Checking Grok");
    expect(snapshot.requiresNewThreadForModelChange).toBe(true);
  });
});

describe("checkGrokProviderStatus", () => {
  it("reports the binary as missing when the binary path does not resolve", async () => {
    const snapshot = await runNode(
      checkGrokProviderStatus(
        decodeGrokSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/grok-binary",
        }),
      ),
    );
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.installed).toBe(false);
    expect(snapshot.status).toBe("error");
    expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
  });

  it("reports an installed CLI as unhealthy when --version exits non-zero", async () => {
    const snapshot = await runNode(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-version-" });
          const grokPath = path.join(dir, "grok");
          yield* fs.writeFileString(
            grokPath,
            ["#!/bin/sh", 'printf "%s\\n" "broken grok install" >&2', "exit 2", ""].join("\n"),
          );
          yield* fs.chmod(grokPath, 0o755);

          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
          );
        }),
      ),
    );

    expect(snapshot.enabled).toBe(true);
    expect(snapshot.installed).toBe(true);
    expect(snapshot.status).toBe("error");
    expect(snapshot.message).toContain("broken grok install");
  });

  it("reports an error when ACP model discovery is unavailable", async () => {
    const snapshot = await runNode(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-success-" });
          const grokPath = path.join(dir, "grok");
          yield* fs.writeFileString(
            grokPath,
            ["#!/bin/sh", 'printf "grok-cli 0.0.99\\n"', "exit 0", ""].join("\n"),
          );
          yield* fs.chmod(grokPath, 0o755);

          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
          );
        }),
      ),
    );

    expect(snapshot.status).toBe("error");
    expect(snapshot.installed).toBe(true);
    expect(snapshot.models.map((model) => model.slug)).toEqual(["grok-build"]);
    expect(snapshot.message).toContain("ACP startup failed");
  });
});
