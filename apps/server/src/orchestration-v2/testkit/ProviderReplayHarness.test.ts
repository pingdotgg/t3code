import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { makeReplayServerConfig as makeCodexReplayServerConfig } from "../Adapters/CodexAdapterV2.testkit.ts";
import { makeReplayServerConfig } from "./ProviderReplayHarness.ts";

it.effect.each([
  { name: "provider replay harness", make: makeReplayServerConfig },
  { name: "Codex replay testkit", make: makeCodexReplayServerConfig },
])("$name deletes its temp state directory when the scenario scope closes", ({ make }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* Effect.gen(function* () {
      const config = yield* make("temp-cleanup");
      assert.isTrue(yield* fs.exists(config.stateDir));
      return config.baseDir;
    }).pipe(Effect.scoped);

    assert.isFalse(yield* fs.exists(baseDir));
  }).pipe(Effect.provide(NodeServices.layer)),
);
