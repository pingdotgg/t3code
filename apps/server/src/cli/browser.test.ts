import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import { browserCommand } from "./browser.ts";

it.effect("setup in a root shell warns that the server cannot run as root", () =>
  Effect.gen(function* () {
    // Every file read fails, so setup finds nothing to install and changes nothing.
    yield* Command.runWith(browserCommand, { version: "0.0.0" })([
      "setup",
      "--base-dir",
      "/nonexistent",
    ]).pipe(
      Effect.provide(FileSystem.layerNoop({})),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.UserId, 0),
      // A root user who follows the old advice runs setup through sudo.
      Effect.provideService(HostProcess.Environment, { SUDO_USER: "root" }),
    );
    const output = (yield* TestConsole.logLines).join("\n");
    expect(output).toContain("Chrome will not start its sandbox as root");
    expect(output).not.toContain("ready");
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, TestConsole.layer))),
);
