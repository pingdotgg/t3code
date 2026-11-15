import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { T3_HOME } from "../e2e.config.ts";
import { ScenarioError } from "./shell.ts";
import { makeState, runPromise, test, WEB } from "./t3.ts";

const SettingsJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeSettings = Schema.decodeEffect(SettingsJson);
const encodeSettings = Schema.encodeEffect(SettingsJson);

// A token from `auth session issue` acts at most in approval-required mode, so the thread must too.
const approvalRequiredThreads = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const settingsPath = (yield* Path.Path).join(T3_HOME, "userdata/settings.json");
  const original = yield* fs.readFileString(settingsPath);
  const settings = yield* decodeSettings(original);
  return {
    apply: fs.writeFileString(
      settingsPath,
      yield* encodeSettings({
        ...settings,
        defaultRuntimeMode: "approval-required",
      }),
    ),
    restore: fs.writeFileString(settingsPath, original),
  };
});

/** Archives a thread as an outside agent does: `t3_thread_organize` on the server's MCP endpoint. */
const archiveOverMcp = Effect.fn("scenario.archiveOverMcp")(function* (
  baseUrl: string,
  threadId: string,
) {
  const { cli } = makeState(T3_HOME);
  const { stdout } = yield* cli([
    "auth",
    "session",
    "issue",
    "--subject",
    "mcp-client",
    "--scope",
    "orchestration:read",
    "--scope",
    "orchestration:operate",
    "--token-only",
  ]);
  const client = yield* HttpClient.HttpClient;
  let sessionId: string | null = null;
  const send = Effect.fnUntraced(function* (message: object) {
    const response = yield* client.execute(
      HttpClientRequest.post(`${baseUrl}/mcp`).pipe(
        HttpClientRequest.setHeaders({
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${stdout.trim()}`,
          ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
        }),
        HttpClientRequest.bodyJsonUnsafe({ jsonrpc: "2.0", ...message }),
      ),
    );
    sessionId = response.headers["mcp-session-id"] ?? sessionId;
    const body = yield* response.text;
    if (response.status >= 300) {
      return yield* new ScenarioError({ message: `MCP ${response.status}: ${body}` });
    }
    return body;
  });
  yield* send({
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "scenario", version: "1" },
    },
  });
  yield* send({ method: "notifications/initialized" });
  const result = yield* send({
    id: 2,
    method: "tools/call",
    params: { name: "t3_thread_organize", arguments: { threadId, action: "archive" } },
  });
  if (result.includes('"isError":true')) {
    return yield* new ScenarioError({ message: `Archive failed: ${result}` });
  }
}, Effect.provide(FetchHttpClient.layer));

test(
  "Settings Archived lists a thread archived elsewhere while it is open",
  WEB,
  async ({ t3, app, screen }) => {
    const settings = await runPromise(approvalRequiredThreads);
    try {
      await runPromise(settings.apply);
      const project = await t3.project("demo");
      const thread = await t3.thread({ project, title: "Archived elsewhere", messages: ["first"] });
      await t3.open("/settings/archived");
      await expect(screen.getByText("No archived threads")).toBeVisible();

      await runPromise(archiveOverMcp(app.baseUrl ?? "", thread.threadId));

      await expect(screen.getByRole("button", "Unarchive Archived elsewhere")).toBeVisible();
      await app.screenshot("archived-list");
    } finally {
      await runPromise(settings.restore);
    }
  },
);
