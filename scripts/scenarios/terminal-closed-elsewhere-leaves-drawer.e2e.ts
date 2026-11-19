import * as NodeWS from "@effect/platform-node/NodeWS";
import { ORCHESTRATION_PROTOCOL_VERSION, ThreadId, WsRpcGroup } from "@t3tools/contracts";
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";

import { T3_HOME } from "../e2e.config.ts";
import { makeState, runPromise, test, WEB } from "./t3.ts";

const terminalClient = Effect.fn("scenario.terminalClient")(function* (origin: string) {
  const issued = yield* makeState(T3_HOME).cli(["auth", "session", "issue", "--token-only"]);
  const { ticket } = yield* HttpClient.execute(
    HttpClientRequest.post(`${origin}/api/auth/websocket-ticket`).pipe(
      HttpClientRequest.bearerToken(issued.stdout.trim()),
    ),
  ).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Struct({ ticket: Schema.String }))),
    Effect.provide(FetchHttpClient.layer),
  );
  const protocol = yield* Layer.build(
    RpcClient.layerProtocolSocket().pipe(
      Layer.provide(
        Socket.layerWebSocket(
          `${origin.replace(/^http/, "ws")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(ticket)}`,
        ),
      ),
      Layer.provide(RpcSerialization.layerJson),
      Layer.provide(NodeWS.layerWebSocketConstructor),
    ),
  );
  return yield* RpcClient.make(WsRpcGroup).pipe(Effect.provideContext(protocol));
});

test("The drawer removes a terminal closed by another client", WEB, async ({ t3, app, screen }) => {
  const cwd = await t3.project("demo");
  const thread = await t3.thread({ project: cwd, title: "Shared terminals", messages: ["first"] });
  const threadId = ThreadId.make(thread.threadId);
  const origin = app.baseUrl ?? "";
  const kept = "kept-shell";
  const closed = "closed-elsewhere";

  await runPromise(
    Effect.gen(function* () {
      const client = yield* terminalClient(origin);
      for (const terminalId of [kept, closed]) {
        yield* client["terminal.open"]({ threadId, terminalId, cwd });
      }
    }).pipe(Effect.scoped),
  );
  await t3.open(thread);
  await screen.getByRole("button", "Toggle terminal drawer").tap();
  await screen.getByRole("button", kept, { exact: true }).tap();
  const closedTab = screen.getByRole("button", closed, { exact: true });
  await closedTab.waitFor();

  await runPromise(
    Effect.gen(function* () {
      const client = yield* terminalClient(origin);
      yield* client["terminal.close"]({ threadId, terminalId: closed, deleteHistory: true });
    }).pipe(Effect.scoped),
  );

  await app.screenshot("after-close-from-another-client");
  await expect(closedTab).toBeHidden();
});
