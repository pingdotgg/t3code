import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { asarUnpackedTwin, resolveT3ClaudePluginLocation } from "./ClaudePlugin.ts";

it("redirects a path inside an asar archive to its unpacked twin", () => {
  assert.equal(
    asarUnpackedTwin(
      "/Applications/T3.app/Contents/Resources/app.asar/apps/server/dist/claude-plugin",
    ),
    "/Applications/T3.app/Contents/Resources/app.asar.unpacked/apps/server/dist/claude-plugin",
  );
  // Windows sidecar, backslash separators.
  assert.equal(
    asarUnpackedTwin(
      "C:\\Program Files\\T3\\resources\\server.asar\\apps\\server\\dist\\claude-plugin",
    ),
    "C:\\Program Files\\T3\\resources\\server.asar.unpacked\\apps\\server\\dist\\claude-plugin",
  );
});

it("leaves paths outside an archive alone", () => {
  assert.equal(asarUnpackedTwin("/repo/apps/server/claude-plugin"), undefined);
  // A directory merely named `*.asar` with nothing below it is not a prefix.
  assert.equal(asarUnpackedTwin("/repo/app.asar"), undefined);
});

it.layer(NodeServices.layer)("resolveT3ClaudePluginLocation", (it) => {
  it.effect("resolves the source-layout plugin and its CLI entry", () =>
    Effect.gen(function* () {
      const location = yield* resolveT3ClaudePluginLocation();

      assert.isDefined(location);
      assert.isTrue(location.pluginDir.endsWith("apps/server/claude-plugin"));
      assert.isTrue(location.cliEntryPath?.endsWith("apps/server/src/bin.ts"));
    }),
  );
});
