// @effect-diagnostics nodeBuiltinImport:off -- The scenario supplies a local ACP agent.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { expect } from "e2e";
import * as Effect from "effect/Effect";

import { T3_HOME } from "../e2e.config.ts";
import { rpcClient, runPromise, test, WEB } from "./t3.ts";

const SESSION_TITLE = "Conversation with temporarily unavailable history";
const ACP = `
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";

const [recovered] = process.argv.slice(2);
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) continue;
  const reply = (body) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...body }) + "\\n");
  if (method === "initialize") {
    reply({ id, result: {
      protocolVersion: 1,
      agentInfo: { name: "history-scenario", version: "1.0.0" },
      agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, delete: {} } },
      authMethods: [],
    } });
  } else if (method === "session/new") {
    reply({ id, result: { sessionId: "health-probe" } });
  } else if (method === "session/list") {
    reply({ id, result: { sessions: [{
      sessionId: "native-history",
      cwd: params.cwd,
      title: ${JSON.stringify(SESSION_TITLE)},
    }] } });
  } else if (method === "session/load") {
    if (!existsSync(recovered)) {
      reply({ id, error: { code: -32000, message: "History temporarily unavailable" } });
      continue;
    }
    reply({ method: "session/update", params: {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "An earlier answer from the native session" },
      },
    } });
    reply({ id, result: {} });
  } else {
    reply({ id, error: { code: -32601, message: "Method not found" } });
  }
}
`;

test(
  "A failed native ACP history read leaves Import available without refreshing Settings",
  WEB,
  async ({ t3, app, screen }) => {
    const instanceId = ProviderInstanceId.make("scenario-history-agent");
    const workspaceRoot = await t3.project("demo", { "history-agent.mjs": ACP });
    const recovered = NodePath.join(workspaceRoot, "history-recovered");
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
              displayName: "History scenario agent",
              enabled: true,
              config: {
                source: "local",
                commandPath: process.execPath,
                commandArgs: [NodePath.join(workspaceRoot, "history-agent.mjs"), recovered],
              },
            },
          },
        });
      }).pipe(Effect.scoped),
    );

    await t3.open(`/settings/providers?instanceId=${instanceId}`);
    await screen.getByRole("button", "List sessions", { exact: true }).tap({ timeout: 60_000 });
    await screen.getByText(SESSION_TITLE, { exact: true }).waitFor();
    const importButton = screen.getByRole("button", "Import", { exact: true });
    const deleteButton = screen.getByRole("button", "Delete", { exact: true });
    await expect(deleteButton).toBeEnabled();
    await importButton.tap();
    await screen.getByRole("button", "Importing", { exact: true }).waitFor({
      state: "hidden",
      timeout: 60_000,
    });
    await NodeFSP.writeFile(recovered, "");
    await app.screenshot("native-session-after-history-failure");
    expect(
      (await importButton.isVisible()) && (await importButton.isEnabled()),
      "Import can be retried after the history read failed",
    ).toBe(true);
    await expect(deleteButton).toBeDisabled();

    await importButton.tap();
    const importedButton = screen.getByRole("button", "Imported", { exact: true });
    await importedButton.waitFor({ timeout: 60_000 });
    await expect(importedButton).toBeDisabled();
    await expect(screen.getByText("ACP session imported", { exact: true })).toBeVisible();
  },
);
