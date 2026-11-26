// @effect-diagnostics nodeBuiltinImport:off -- The scenario starts a local ACP fixture.
import * as NodePath from "node:path";

import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { expect } from "e2e";
import * as Effect from "effect/Effect";

import { T3_HOME } from "../e2e.config.ts";
import { makeState, rpcClient, runPromise, test, WEB } from "./t3.ts";

// The agent asks one optional choice with an `<id>_other` text field, then replies with the form
// content it received.
const ACP = `
import { createInterface } from "node:readline";

const sessionId = "note-question-session";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
let promptId;
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, result } = JSON.parse(line);
  if (id === "ask-database" && method === undefined && promptId !== undefined) {
    send({ method: "session/update", params: { sessionId, update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Received " + JSON.stringify(result?.content ?? null) },
    } } });
    send({ id: promptId, result: { stopReason: "end_turn" } });
    promptId = undefined;
    continue;
  }
  if (id === undefined || method === undefined) continue;
  if (method === "initialize") {
    send({ id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [],
      agentInfo: { name: "Note fixture", version: "1.0.0" } } });
  } else if (method === "session/new") {
    send({ id, result: { sessionId } });
  } else if (method === "session/prompt") {
    promptId = id;
    send({
      id: "ask-database",
      method: "elicitation/create",
      params: {
        sessionId,
        mode: "form",
        message: "Answer 1 question",
        requestedSchema: {
          type: "object",
          properties: {
            database: {
              type: "string",
              title: "Database",
              description: "Use Postgres for the new service?",
              oneOf: [{ const: "Yes", title: "Yes" }, { const: "No", title: "No" }],
            },
            database_other: { type: "string", title: "Other" },
          },
        },
      },
    });
  } else {
    send({ id, error: { code: -32601, message: "Method not found" } });
  }
}
`;

test(
  "A note typed before picking an option reaches the agent with the pick",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo", { "note-agent.mjs": ACP });
    const instanceId = ProviderInstanceId.make("scenario-note-agent");
    await runPromise(
      Effect.gen(function* () {
        const client = yield* rpcClient(T3_HOME, app.baseUrl ?? "");
        yield* client["server.updateSettings"]({
          patch: {},
          providerInstanceMutation: {
            operation: "upsert",
            instanceId,
            instance: {
              driver: ProviderDriverKind.make("acpRegistry"),
              displayName: "Note fixture",
              enabled: true,
              config: {
                source: "local",
                commandPath: process.execPath,
                commandArgs: [NodePath.join(project, "note-agent.mjs")],
              },
            },
          },
        });
      }).pipe(Effect.scoped),
    );
    const { cli } = makeState(T3_HOME);
    const started = await runPromise(
      cli(
        [
          "thread",
          "start",
          project,
          "Ask me about the database.",
          "--title",
          "Database question",
          "--provider",
          instanceId,
          "--model",
          "default",
          "--wait",
          "--json",
        ],
        [2],
      ),
    );
    const { threadId } = JSON.parse(started.stdout) as { threadId: string };
    await t3.open({ threadId });

    const composer = browser.locator('[data-chat-composer-form="true"]');
    await browser
      .locator('[data-chat-composer-form="true"] [data-pending-user-input-toggle]')
      .waitFor({ timeout: 60_000 });
    await app.screenshot("question-before-note");
    await composer.getByRole("textbox").fill("but on a new host");
    await app.screenshot("note-typed-before-pick");
    await composer.getByRole("button", /^Yes/).tap();

    await expect(
      screen.getByText('Received {"database":"Yes","database_other":"but on a new host"}'),
    ).toBeVisible({ timeout: 30_000 });
    await app.screenshot("agent-received-pick-and-note");
  },
);
