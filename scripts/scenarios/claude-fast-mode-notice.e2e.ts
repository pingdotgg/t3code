import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { T3_HOME } from "../e2e.config.ts";
import { runPromise, test, WEB } from "./t3.ts";

const FAST_OFF = "Fast mode is off (extra usage disabled), using standard speed";
const OVERAGE = "Fast mode disabled · Out of usage credits";
const REPLY = "Answered at standard speed.";

const Settings = Schema.fromJsonString(
  Schema.StructWithRest(
    Schema.Struct({ providerInstances: Schema.Record(Schema.String, Schema.Unknown) }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
);
const decodeSettings = Schema.decodeEffect(Settings);
const encodeSettings = Schema.encodeEffect(Settings);

// Claude Opus 5.5 with Fast on, run by a stand-in CLI that replays Claude Code's Fast frames.
const useFakeClaude = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(T3_HOME, "userdata/settings.json");
  const original = yield* fs.readFileString(file);
  const settings = yield* decodeSettings(original);
  const binaryPath = path.join(
    yield* path.fromFileUrl(new URL(".", import.meta.url)),
    "claude-fast-mode-cli.mjs",
  );
  const fastClaude = {
    ...settings,
    providerInstances: {
      ...settings.providerInstances,
      claudeAgent: { driver: "claudeAgent", enabled: true, config: { binaryPath } },
    },
    defaultModelSelection: {
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
      options: [{ id: "fastMode", value: true }],
    },
  };
  yield* fs.writeFileString(file, yield* encodeSettings(fastClaude));
  return fs.writeFileString(file, original);
});

test(
  "A Fast Claude turn that runs at standard speed says so once per process",
  WEB,
  async ({ t3, app, screen }) => {
    const restore = await runPromise(useFakeClaude);
    try {
      await t3.project("demo");
      await t3.open();

      // Waits for the turn's own reply, the stand-in CLI's last frame before its result.
      const send = async (text: string, replies: number) => {
        await screen.getByRole("textbox").fill(text);
        await screen.getByRole("textbox").press("Enter");
        await expect(screen.getByText(REPLY)).toHaveCount(replies);
        await expect(screen.getByRole("button", "Stop generation")).toBeHidden();
      };

      await send("Summarize the README", 1);
      await expect(screen.getByText(FAST_OFF)).toBeVisible();
      await send("And the license?", 2);
      await expect(screen.getByText(FAST_OFF)).toHaveCount(1);
      await app.screenshot("extra-usage-disabled");

      await screen.getByRole("button", "New thread").first().tap();
      await send("Use my usage credits", 1);
      await expect(screen.getByText(OVERAGE)).toBeVisible();
      await app.screenshot("out-of-credits");
    } finally {
      await runPromise(restore);
    }
  },
);
