// @effect-diagnostics nodeBuiltinImport:off -- The scenario starts a local ACP fixture.
import * as NodePath from "node:path";

import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { expect } from "e2e";
import * as Effect from "effect/Effect";

import { T3_HOME } from "../e2e.config.ts";
import {
  expectHeldImageCompressions,
  finishImageCompression,
  holdImageCompression,
  pasteWideScreenshot,
} from "./image-compression-hold.ts";
import { makeState, rpcClient, runPromise, test, WEB } from "./t3.ts";

const ACP = `
import { createInterface } from "node:readline";

const sessionId = "image-question-session";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
let promptId;
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method } = JSON.parse(line);
  if (method === "session/cancel" && promptId !== undefined) {
    send({ id: promptId, result: { stopReason: "cancelled" } });
    promptId = undefined;
  }
  if (id === undefined || method === undefined) continue;
  if (method === "initialize") {
    send({ id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } }, authMethods: [],
      agentInfo: { name: "Question fixture", version: "1.0.0" } } });
  } else if (method === "session/new") {
    send({ id, result: { sessionId } });
  } else if (method === "session/prompt") {
    promptId = id;
    send({
      id: "ask-image-question",
      method: "elicitation/create",
      params: {
        sessionId,
        mode: "form",
        message: "What should we look at?",
        requestedSchema: {
          type: "object",
          properties: { answer: { type: "string", title: "Screenshot question" } },
          required: ["answer"],
        },
      },
    });
  } else {
    send({ id, error: { code: -32601, message: "Method not found" } });
  }
}
`;

test(
  "Stopping an unanswered question keeps a screenshot that is still preparing",
  WEB,
  async ({ t3, app, browser }) => {
    await holdImageCompression(browser);
    const project = await t3.project("demo", { "question-agent.mjs": ACP });
    const instanceId = ProviderInstanceId.make("scenario-question-agent");
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
              displayName: "Question fixture",
              enabled: true,
              config: {
                source: "local",
                commandPath: process.execPath,
                commandArgs: [NodePath.join(project, "question-agent.mjs")],
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
          "Ask for a screenshot.",
          "--title",
          "Screenshot question thread",
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
    const question = browser.locator(
      '[data-chat-composer-form="true"] [data-pending-user-input-toggle]',
    );
    await question.waitFor({ timeout: 60_000 });
    await composer.getByRole("textbox").fill("Here is the screenshot.");
    await pasteWideScreenshot(browser);
    await expectHeldImageCompressions(browser, 1);
    await composer.getByRole("button", "Stop generation").tap();
    await question.waitFor({ state: "hidden" });

    await finishImageCompression(browser);
    await app.screenshot("draft-after-stopping-question");
    await expect(
      browser.locator(
        '[data-chat-composer-form="true"] button[aria-label="Preview screenshot.png"]:enabled',
      ),
    ).toBeVisible();
  },
);
