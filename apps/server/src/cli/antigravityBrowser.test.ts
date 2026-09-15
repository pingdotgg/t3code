import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";

import { ANTIGRAVITY_AUTH_BROWSER_MARKER } from "../provider/antigravityAuthSupport.ts";
import { antigravityBrowserCommand } from "./antigravityBrowser.ts";

it.effect("writes the Antigravity authorization URL marker to stderr", () =>
  Effect.gen(function* () {
    const url = "https://accounts.google.com/example?state=opaque";
    yield* Command.runWith(antigravityBrowserCommand, { version: "0.0.0" })([url]);

    assert.deepEqual(yield* TestConsole.errorLines, [
      `${ANTIGRAVITY_AUTH_BROWSER_MARKER}"https://accounts.google.com/example?state=opaque"`,
    ]);
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, TestConsole.layer))),
);
