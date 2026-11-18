import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { T3_HOME } from "../e2e.config.ts";
import { run } from "./shell.ts";
import { makeState, runPromise, test, WEB } from "./t3.ts";

// One more conversation than an import attempt reads.
const SESSIONS = 101;

const sessionId = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

const rollout = (cwd: string, index: number) =>
  [
    { type: "session_meta", payload: { id: sessionId(index), cwd } },
    { type: "event_msg", payload: { type: "user_message", message: `Request ${index}` } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Done" }],
      },
    },
  ]
    .map((record) => `${JSON.stringify(record)}\n`)
    .join("");

const JsonObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeSettings = Schema.decodeUnknownEffect(JsonObject);
const encodeSettings = Schema.encodeEffect(JsonObject);
const decodeProviderInstances = Schema.decodeUnknownEffect(
  Schema.Record(Schema.String, Schema.Unknown),
);

/**
 * A repository and a Codex home holding its sessions, outside the T3 home, which the scanner
 * skips. The scenario app keeps Codex off; this turns it on with that home.
 */
const seed = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectory({ prefix: "t3-import-deferred-" });
  const workspace = path.join(root, "demo-app");
  const codexHome = path.join(root, "codex");
  const sessions = path.join(codexHome, "sessions", "2026", "01", "01");
  yield* fs.makeDirectory(workspace, { recursive: true });
  yield* fs.makeDirectory(sessions, { recursive: true });
  for (let index = 0; index < SESSIONS; index++) {
    yield* fs.writeFileString(
      path.join(sessions, `rollout-2026-01-01T00-00-00-${sessionId(index)}.jsonl`),
      rollout(workspace, index),
    );
  }

  const settingsPath = path.join(T3_HOME, "userdata", "settings.json");
  const original = yield* fs.readFileString(settingsPath);
  const settings = yield* decodeSettings(original);
  const providerInstances = yield* decodeProviderInstances(settings.providerInstances);
  yield* fs.writeFileString(
    settingsPath,
    yield* encodeSettings({
      ...settings,
      providerInstances: {
        ...providerInstances,
        codex: {
          driver: "codex",
          enabled: true,
          config: { binaryPath: path.join(T3_HOME, "bin", "no-model"), homePath: codexHome },
        },
      },
    }),
  );
  // The server is shared by later tests, so they get its settings back without this project.
  const restore = Effect.gen(function* () {
    yield* makeState(T3_HOME).cli(["project", "remove", workspace, "--force"]).pipe(Effect.ignore);
    yield* fs.writeFileString(settingsPath, original);
    yield* fs.remove(root, { recursive: true });
  });
  return { workspace, restore };
});

test(
  "Importing more conversations than one attempt reads reports the rest as not imported yet",
  WEB,
  async ({ t3, app, screen }) => {
    const { workspace, restore } = await runPromise(seed);
    try {
      await runPromise(
        run("git", ["init", "--quiet", "--initial-branch=main"], { cwd: workspace }),
      );

      // The server reloads settings.json while the page signs in; it scans once it opens.
      await t3.open();
      await screen.getByRole("button", "Import 1 project and start").tap();
      const summary = screen.getByText("Imported 100 threads.", { exact: false });
      await summary.waitFor({ timeout: 60_000 });
      await app.screenshot("import-summary");

      await expect(summary).toHaveText(
        "Imported 100 threads. 1 thread was not imported yet. To import them, open the Welcome page again from Settings → About and select their projects under Review all.",
      );
    } finally {
      await runPromise(restore);
    }
  },
);
