// @effect-diagnostics nodeBuiltinImport:off -- The scenario supplies a local ACP agent with a gated list.
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { expect } from "e2e";
import * as Effect from "effect/Effect";

import { T3_HOME } from "../e2e.config.ts";
import { rpcClient, runPromise, test, WEB } from "./t3.ts";

const SESSION_TITLE = "Native draft to delete";
const ACP = `
import { createInterface } from "node:readline";

const [origin] = process.argv.slice(2);
const reply = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const handle = async ({ method, params }) => {
  if (method === "initialize") {
    return {
      protocolVersion: 1,
      agentInfo: { name: "session-scenario", version: "1.0.0" },
      agentCapabilities: { sessionCapabilities: { list: {}, delete: {} } },
      authMethods: [],
    };
  }
  if (method === "session/new") return { sessionId: "health-probe" };
  if (method === "session/list") {
    const response = await fetch(origin + "/list");
    const { present, title } = await response.json();
    return { sessions: present ? [{ sessionId: "native-draft", cwd: params.cwd, title }] : [] };
  }
  if (method === "session/delete") {
    if (params.sessionId === "native-draft") await fetch(origin + "/delete");
    return {};
  }
  return undefined;
};
// A gated session/list must not block the session/delete that arrives while it waits.
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  void handle(request).then((result) =>
    reply(
      result === undefined
        ? { id: request.id, error: { code: -32601, message: "Method not found" } }
        : { id: request.id, result },
    ),
  );
});
`;

test(
  "Refreshing native ACP sessions does not bring back a session deleted during the refresh",
  WEB,
  async ({ t3, app, screen }) => {
    const instanceId = ProviderInstanceId.make("scenario-session-agent");
    const snapshotTaken = Promise.withResolvers<void>();
    const releaseSnapshot = Promise.withResolvers<void>();
    let present = true;
    let holdNextList = false;
    const state = NodeHttp.createServer((request, response) => {
      if (request.url === "/list") {
        const snapshot = JSON.stringify({ present, title: SESSION_TITLE });
        const reply = () =>
          response.writeHead(200, { "Content-Type": "application/json" }).end(snapshot);
        if (holdNextList) {
          holdNextList = false;
          snapshotTaken.resolve();
          void releaseSnapshot.promise.then(reply);
        } else {
          reply();
        }
      } else if (request.url === "/delete") {
        present = false;
        response.writeHead(204).end();
      } else {
        response.writeHead(404).end();
      }
    });

    try {
      await new Promise<void>((resolve) => state.listen(0, "127.0.0.1", resolve));
      const address = state.address();
      if (address === null || typeof address === "string") throw new Error("No fixture port");
      const project = await t3.project("demo", { "session-agent.mjs": ACP });
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
                displayName: "Session scenario agent",
                enabled: true,
                config: {
                  source: "local",
                  commandPath: process.execPath,
                  commandArgs: [
                    NodePath.join(project, "session-agent.mjs"),
                    `http://127.0.0.1:${address.port}`,
                  ],
                },
              },
            },
          });
        }).pipe(Effect.scoped),
      );
      await t3.open(`/settings/providers?instanceId=${instanceId}`);
      await screen.getByRole("button", "List sessions", { exact: true }).tap({ timeout: 60_000 });
      const entry = screen.getByText(SESSION_TITLE, { exact: true });
      await entry.waitFor();

      holdNextList = true;
      await screen.getByRole("button", "Refresh", { exact: true }).tap();
      await snapshotTaken.promise;
      const remove = screen.getByRole("button", "Delete", { exact: true });
      const loading = screen.getByRole("button", "Loading", { exact: true });
      if (!(await remove.isVisible()) || !(await remove.isEnabled())) {
        releaseSnapshot.resolve();
        await loading.waitFor({ state: "hidden" });
      }
      await remove.tap();
      const confirm = screen.getByRole("alertdialog");
      await confirm.getByRole("button", "Confirm", { exact: true }).tap();
      await entry.waitFor({ state: "hidden" });
      expect(await loading.isVisible(), "The refresh is still pending after deletion").toBe(true);

      releaseSnapshot.resolve();
      await loading.waitFor({ state: "hidden" });
      await app.screenshot("after-deletion-and-refresh");
      expect(await entry.isVisible(), "The deleted native session stays off the list").toBe(false);
    } finally {
      releaseSnapshot.resolve();
      state.close();
      state.closeAllConnections();
    }
  },
);
