import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { T3_HOME } from "../e2e.config.ts";
import { makeState, runPromise, test, WEB } from "./t3.ts";

const SettingsJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeSettings = Schema.decodeEffect(SettingsJson);
const encodeSettings = Schema.encodeEffect(SettingsJson);
const ThreadSnapshot = Schema.Struct({
  projection: Schema.Struct({
    runs: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        userMessageId: Schema.String,
        status: Schema.String,
        queueHeld: Schema.optional(Schema.Boolean),
      }),
    ),
    messages: Schema.Array(
      Schema.Struct({ id: Schema.String, scheduledTaskId: Schema.optional(Schema.String) }),
    ),
  }),
});
const threadRuntimeSettings = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const settingsPath = (yield* Path.Path).join(T3_HOME, "userdata/settings.json");
  const original = yield* fs.readFileString(settingsPath);
  const settings = yield* decodeSettings(original);
  return {
    supervise: fs.writeFileString(
      settingsPath,
      yield* encodeSettings({
        ...settings,
        defaultRuntimeMode: "approval-required",
      }),
    ),
    restore: fs.writeFileString(settingsPath, original),
  };
});

test(
  "A recurring task reports when its queued occurrence is held",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const settings = await runPromise(threadRuntimeSettings);
    try {
      await runPromise(settings.supervise);
      const project = await t3.project("scheduled-hold");
      await t3.thread({
        project,
        title: "Discover replay models",
        messages: ["Start"],
        model: "default",
      });
      const thread = await t3.thread({
        project,
        title: "Waiting scheduled thread",
        messages: ["Ask a question"],
        model: "approval",
      });
      const { cli } = makeState(T3_HOME);
      const pairing = await runPromise(cli(["auth", "pairing", "create", "--json"]));
      const { credential } = JSON.parse(pairing.stdout) as { credential: string };
      await app.open(`/pair#token=${encodeURIComponent(credential)}`);
      await expect(browser).not.toHaveURL(/\/pair(?:[?#]|$)/, { timeout: 60_000 });
      const environmentId = await runPromise(
        HttpClient.get(`${app.baseUrl ?? ""}/.well-known/t3/environment`).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(
            HttpClientResponse.schemaBodyJson(Schema.Struct({ environmentId: Schema.String })),
          ),
          Effect.map((environment) => environment.environmentId),
          Effect.provide(FetchHttpClient.layer),
        ),
      );
      const threadUrl = `/${environmentId}/${thread.threadId}`;

      await app.open("/settings/scheduled-tasks");
      await screen.getByRole("button", "New task").tap();
      await screen.getByRole("textbox", "Name").fill("Held recurring task");
      await screen.getByRole("combobox", "Destination").tap();
      await screen.getByRole("option", "One thread, continuing the conversation").tap();
      await screen.getByRole("combobox", "Destination thread").tap();
      await screen.getByRole("option", "Waiting scheduled thread").tap();
      await screen.getByRole("textbox", "Prompt").fill("Scheduled check prompt");
      await screen.getByRole("button", "Every interval").tap();
      await screen.getByRole("spinbutton", "Run every").fill("1");
      await screen.getByRole("button", "Create task").tap();

      await app.open(threadUrl);
      await expect(screen.getByRole("button", "Approve", { exact: true })).toBeVisible();
      await expect(screen.getByRole("button", "Automation Held recurring task")).toBeVisible({
        timeout: 100_000,
      });
      await expect(screen.getByRole("button", "Edit queued message")).toBeVisible();
      const session = await runPromise(
        cli(["auth", "session", "issue", "--scope", "orchestration:read", "--token-only"]),
      );
      const readThread = () =>
        runPromise(
          HttpClient.execute(
            HttpClientRequest.get(
              `${app.baseUrl ?? ""}/api/orchestration/threads/${encodeURIComponent(thread.threadId)}`,
            ).pipe(
              HttpClientRequest.setHeaders({
                authorization: `Bearer ${session.stdout.trim()}`,
                "x-t3-orchestration-protocol": "2",
              }),
            ),
          ).pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(ThreadSnapshot)),
            Effect.provide(FetchHttpClient.layer),
          ),
        );
      const beforeStop = (await readThread()).projection;
      const scheduledMessageIds = new Set(
        beforeStop.messages
          .filter((message) => message.scheduledTaskId !== undefined)
          .map((message) => message.id),
      );
      const queued = beforeStop.runs.find(
        (run) => run.status === "queued" && scheduledMessageIds.has(run.userMessageId),
      );
      expect(queued).toBeDefined();
      await screen.getByRole("button", "Stop generation").tap();
      await expect(screen.getByRole("button", "Resume thread")).toBeVisible();
      await expect(screen.getByRole("button", "Edit queued message")).toBeVisible();
      await expect
        .poll(async () =>
          (await readThread()).projection.runs.some(
            (run) => run.id === queued?.id && run.status === "queued" && run.queueHeld === true,
          ),
        )
        .toBe(true);
      await app.open("/settings/scheduled-tasks");
      await expect(
        screen.getByText(
          "A previous occurrence is held in the thread queue. Resume or remove it to run this task again.",
        ),
      ).toBeVisible({ timeout: 100_000 });
      await app.screenshot("held-scheduled-task");
    } finally {
      await runPromise(settings.restore);
    }
  },
);
