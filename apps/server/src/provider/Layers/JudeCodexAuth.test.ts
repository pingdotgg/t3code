import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexRpc from "effect-codex-app-server/rpc";
import { makeJudeCodexAuth } from "./JudeCodexAuth.ts";

const decodeBrokerRequest = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      previousAccessTokenHash: Schema.String,
    }),
  ),
);

it.layer(NodeServices.layer)("JudeCodexAuth", (it) => {
  it.effect("authenticates Codex and refreshes through the Jude broker", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const serviceTokenFile = yield* fileSystem.makeTempFileScoped({ prefix: "jude-sa-token-" });
      yield* fileSystem.writeFileString(serviceTokenFile, " service-account-token\n");

      const brokerRequests: Array<{
        readonly authorization: string | undefined;
        readonly body: { readonly previousAccessTokenHash: string };
      }> = [];
      const httpClient = HttpClient.make((request) =>
        Effect.sync(() => {
          assert.strictEqual(request.body._tag, "Uint8Array");
          if (request.body._tag !== "Uint8Array") {
            return assert.fail("expected a JSON request body");
          }
          const body = decodeBrokerRequest(new TextDecoder().decode(request.body.body));
          brokerRequests.push({
            authorization: request.headers.authorization,
            body,
          });
          const sequence = brokerRequests.length;
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              accessToken: `access-${sequence}`,
              accessTokenHash: `hash-${sequence}`,
              chatgptAccountId: "account-1",
              chatgptPlanType: "pro",
            }),
          );
        }),
      );

      let refreshHandler:
        | (() => Effect.Effect<
            CodexRpc.ServerRequestResponsesByMethod["account/chatgptAuthTokens/refresh"],
            never
          >)
        | undefined;
      const loginRequests: unknown[] = [];
      const client = {
        handleServerRequest: (_method: string, handler: () => Effect.Effect<unknown, never>) =>
          Effect.sync(() => {
            refreshHandler = handler as typeof refreshHandler;
          }),
        request: (_method: string, payload: unknown) =>
          Effect.sync(() => {
            loginRequests.push(payload);
            return {};
          }),
      } as unknown as CodexClient.CodexAppServerClient["Service"];

      const auth = makeJudeCodexAuth(
        {
          JUDE_OPENAI_AUTH_BROKER_URL: "https://jude.example.test/internal/openai-auth/token",
          JUDE_OPENAI_AUTH_SERVICE_TOKEN_FILE: serviceTokenFile,
        },
        { fileSystem, httpClient },
      );
      assert.ok(auth);

      yield* auth.authenticate(client);
      assert.ok(refreshHandler);
      const refreshed = yield* refreshHandler();

      assert.deepStrictEqual(loginRequests, [
        {
          type: "chatgptAuthTokens",
          accessToken: "access-1",
          chatgptAccountId: "account-1",
          chatgptPlanType: "pro",
        },
      ]);
      assert.deepStrictEqual(refreshed, {
        accessToken: "access-2",
        chatgptAccountId: "account-1",
        chatgptPlanType: "pro",
      });
      assert.deepStrictEqual(brokerRequests, [
        {
          authorization: "Bearer service-account-token",
          body: { previousAccessTokenHash: "" },
        },
        {
          authorization: "Bearer service-account-token",
          body: { previousAccessTokenHash: "hash-1" },
        },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("stays disabled without a Jude broker URL", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const auth = makeJudeCodexAuth(
        {},
        {
          fileSystem,
          httpClient: HttpClient.make(() => Effect.die("unexpected broker request")),
        },
      );
      assert.strictEqual(auth, undefined);
    }),
  );
});
