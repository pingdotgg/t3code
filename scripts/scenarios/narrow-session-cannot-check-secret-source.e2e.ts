/// <reference lib="dom" />
import * as NodeWS from "@effect/platform-node/NodeWS";
import {
  AuthProvidersManageScope,
  AuthStandardClientScopes,
  EnvironmentHttpApi,
  ORCHESTRATION_PROTOCOL_VERSION,
  SecretProviderId,
  SecretProviderKind,
  WsRpcGroup,
} from "@t3tools/contracts";
import { expect } from "e2e";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  Cookies,
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";

import { T3_HOME } from "../e2e.config.ts";
import { environmentId, makeState, rpcClient, runPromise, test, WEB } from "./t3.ts";

const PROVIDER = SecretProviderId.make("scenario");
const UI_REFERENCE = "op://Scenario/GitHub/ui";
// Named only in the direct call, so a read of it can come from nothing else.
const RPC_REFERENCE = "op://Scenario/GitHub/rpc";
const OP_CALLS = `${T3_HOME}/op-calls.txt`;
const NARROW_SCOPES = AuthStandardClientScopes.filter(
  (scope) => scope !== AuthProvidersManageScope,
);
const scopeFlags = NARROW_SCOPES.flatMap((scope) => ["--scope", scope]);

const decodePairing = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ credential: Schema.String })),
);

const opCalls = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return (yield* fs.exists(OP_CALLS)) ? yield* fs.readFileString(OP_CALLS) : "";
});

/** Browser cookies for a pairing credential holding every standard scope but providers:manage. */
const narrowBrowserCookies = Effect.fn("scenario.narrowBrowserCookies")(function* (
  baseUrl: string,
) {
  const issued = yield* makeState(T3_HOME).cli([
    "auth",
    "pairing",
    "create",
    "--json",
    "--label",
    "narrow",
    ...scopeFlags,
  ]);
  const { credential } = yield* decodePairing(issued.stdout);
  const client = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl });
  const response = yield* client.auth
    .browserSession({ payload: { credential }, responseMode: "response-only" })
    .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
  const now = yield* Clock.currentTimeMillis;
  return Cookies.mergeIntoArray([], baseUrl, response.cookies, now).map(
    ({ name, value, options = {} }) => ({
      name,
      value,
      url: baseUrl,
      ...(options.httpOnly !== undefined && { httpOnly: options.httpOnly }),
      ...(options.secure !== undefined && { secure: options.secure }),
      ...(options.sameSite && {
        sameSite: ({ lax: "Lax", strict: "Strict", none: "None" } as const)[options.sameSite],
      }),
    }),
  );
}, Effect.provide(FetchHttpClient.layer));

/** `server.checkSecretSource` sent over a WebSocket signed in with the narrow scopes. */
const narrowCheck = Effect.fn("scenario.narrowCheck")(function* (origin: string) {
  const issued = yield* makeState(T3_HOME).cli([
    "auth",
    "session",
    "issue",
    "--token-only",
    ...scopeFlags,
  ]);
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
  const client = yield* RpcClient.make(WsRpcGroup).pipe(Effect.provideContext(protocol));
  return yield* client["server.checkSecretSource"]({
    source: { provider: PROVIDER, reference: RPC_REFERENCE },
  }).pipe(
    Effect.map((result) => `answered ${result._tag}`),
    Effect.catch((error) =>
      Effect.succeed(
        error._tag === "EnvironmentAuthorizationError"
          ? `refused: needs ${error.requiredPermission ?? error.requiredScope}`
          : `failed: ${String(error)}`,
      ),
    ),
  );
});

test(
  "A session without providers:manage cannot check a secret source",
  WEB,
  async ({ app, browser, screen }) => {
    const origin = app.baseUrl ?? "";
    const environment = await runPromise(environmentId(origin));
    await runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // The home outlives an attempt; a retry must not see the last attempt's reads.
        yield* fs.remove(OP_CALLS, { force: true });
        yield* fs.writeFileString(
          `${T3_HOME}/bin/op`,
          `#!/bin/sh\necho "$*" >> "${OP_CALLS}"\nprintf scenario-secret\n`,
        );
        yield* fs.chmod(`${T3_HOME}/bin/op`, 0o755);
        const client = yield* rpcClient(T3_HOME, origin);
        yield* client["server.updateSettings"]({
          patch: {
            secretProviders: {
              [PROVIDER]: {
                kind: SecretProviderKind.make("one_password"),
                label: "Scenario",
                config: { account: "scenario" },
              },
            },
            sourceControlHosts: {
              github: {
                tokens: { "github.com": { provider: PROVIDER, reference: UI_REFERENCE } },
              },
            },
          },
        });
      }).pipe(Effect.scoped),
    );

    // The server is the boundary: ask it directly with the narrow session.
    const direct = await runPromise(narrowCheck(origin).pipe(Effect.scoped));
    const readByDirectCall = (await runPromise(opCalls)).includes(RPC_REFERENCE);

    await browser.setCookies(await runPromise(narrowBrowserCookies(origin)));
    await app.open(`/settings/source-control?machine=${encodeURIComponent(environment)}`);
    // Enabled only once the session has loaded with settings:write, so a disabled check
    // below means the missing providers:manage, not a session still loading. A cold
    // machine's first source control scan can outlast the default wait.
    await expect(
      screen.getByRole("switch", "Offer GitHub when adding or publishing a project", {
        exact: true,
      }),
    ).toBeEnabled({ timeout: 60_000 });
    await screen.getByRole("button", "Toggle GitHub details", { exact: true }).tap();
    const check = screen.getByRole("button", "Check GitHub token", { exact: true });
    await expect(check).toBeVisible();
    const uiReads = async () =>
      (await runPromise(opCalls)).split("\n").filter((line) => line.includes(UI_REFERENCE)).length;
    const readsBefore = await uiReads();
    const checkable = await check.isEnabled();
    if (checkable) {
      await check.tap();
      await expect(browser.locator('[aria-label^="Check GitHub token "]')).toBeVisible();
    }
    await browser.evaluate(() => {
      document
        .querySelector('[aria-label="Toggle GitHub details"]')
        ?.scrollIntoView({ block: "start" });
      return null;
    });
    await app.screenshot("check-button-narrow-session");
    const readsByButton = (await uiReads()) - readsBefore;

    expect(
      readByDirectCall,
      `The narrow session's direct check never ran op (op calls: ${await runPromise(opCalls)})`,
    ).toBe(false);
    expect(direct, "The server refuses the narrow session's check").toBe(
      "refused: needs providers:manage",
    );
    expect(
      checkable,
      `The check button is disabled for the narrow session (its click ran op ${readsByButton} times)`,
    ).toBe(false);
  },
);
