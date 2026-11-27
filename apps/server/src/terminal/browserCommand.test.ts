import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { writeTerminalBrowserCommand } from "./browserCommand.ts";

it.effect("writes a BROWSER script that reaches this server's own state", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-browser-command-" });
    const write = (input: {
      readonly stateDir: string;
      readonly devUrl?: URL;
      readonly platform?: NodeJS.Platform;
    }) =>
      writeTerminalBrowserCommand({
        baseDir: root,
        stateDir: path.join(root, input.stateDir),
        devUrl: input.devUrl,
      }).pipe(
        Effect.provideService(HostProcess.Platform, input.platform ?? "linux"),
        Effect.provideService(HostProcess.ExecutablePath, "/opt/T3 Code/node"),
        Effect.provideService(HostProcess.IsExecutable, false),
        Effect.provideService(HostProcess.Arguments, ["/opt/T3 Code/node", "/opt/t3/bin.mjs"]),
      );
    const script = (scriptPath: string | undefined) =>
      scriptPath === undefined ? Effect.undefined : fs.readFileString(scriptPath);

    const userdata = yield* write({ stateDir: "userdata", devUrl: new URL("http://x:5733") });
    expect(userdata).toBe(path.join(root, "userdata", "bin", "t3-browser"));
    expect(yield* script(userdata)).toBe(
      `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '/opt/T3 Code/node' '/opt/t3/bin.mjs' 'browser' 'open' '--base-dir' '${root}' "$@"\n`,
    );
    expect((yield* fs.stat(userdata!)).mode & 0o111).not.toBe(0);

    const dev = yield* write({ stateDir: "dev", devUrl: new URL("http://localhost:5733") });
    expect(yield* script(dev)).toContain(`'open' '--dev-url' 'http://localhost:5733/' "$@"`);

    expect(yield* write({ stateDir: "userdata", platform: "win32" })).toBeUndefined();
    expect(yield* write({ stateDir: "user data" })).toBeUndefined();
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
