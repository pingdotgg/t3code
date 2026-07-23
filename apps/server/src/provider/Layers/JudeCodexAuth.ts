import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexSchema from "effect-codex-app-server/schema";

const DEFAULT_SERVICE_ACCOUNT_TOKEN_FILE = "/var/run/secrets/kubernetes.io/serviceaccount/token";

const JudeBrokerToken = Schema.Struct({
  accessToken: Schema.String,
  accessTokenHash: Schema.String,
  chatgptAccountId: Schema.String,
  chatgptPlanType: Schema.optionalKey(Schema.String),
});

type JudeBrokerToken = typeof JudeBrokerToken.Type;

export interface CodexAppServerAuth {
  readonly authenticate: (
    client: CodexClient.CodexAppServerClient["Service"],
  ) => Effect.Effect<void, CodexErrors.CodexAppServerError>;
}

export type CodexAppServerAuthFactory = () => CodexAppServerAuth | undefined;

export function makeJudeCodexAuth(
  environment: NodeJS.ProcessEnv,
  dependencies: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly httpClient: HttpClient.HttpClient;
  },
): CodexAppServerAuth | undefined {
  const brokerUrl = environment.JUDE_OPENAI_AUTH_BROKER_URL?.trim();
  if (!brokerUrl) {
    return undefined;
  }

  const serviceTokenFile =
    environment.JUDE_OPENAI_AUTH_SERVICE_TOKEN_FILE?.trim() || DEFAULT_SERVICE_ACCOUNT_TOKEN_FILE;
  let previousAccessTokenHash = "";
  const brokerError = () =>
    CodexErrors.CodexAppServerRequestError.internalError(
      "Failed to obtain Jude-managed Codex authentication tokens.",
    );

  const fetchToken = Effect.fn("JudeCodexAuth.fetchToken")(function* (refresh: boolean) {
    const serviceToken = (yield* dependencies.fileSystem
      .readFileString(serviceTokenFile)
      .pipe(Effect.mapError(brokerError))).trim();
    if (!serviceToken) {
      return yield* brokerError();
    }

    const response = yield* HttpClientRequest.post(brokerUrl).pipe(
      HttpClientRequest.bearerToken(serviceToken),
      HttpClientRequest.bodyJson({
        previousAccessTokenHash: refresh ? previousAccessTokenHash : "",
      }),
      Effect.flatMap(dependencies.httpClient.execute),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(JudeBrokerToken)),
      Effect.mapError(brokerError),
    );
    previousAccessTokenHash = response.accessTokenHash;
    return response;
  });

  const toCodexTokenResponse = (
    token: JudeBrokerToken,
  ): CodexSchema.ChatgptAuthTokensRefreshResponse => ({
    accessToken: token.accessToken,
    chatgptAccountId: token.chatgptAccountId,
    ...(token.chatgptPlanType ? { chatgptPlanType: token.chatgptPlanType } : {}),
  });

  return {
    authenticate: Effect.fn("JudeCodexAuth.authenticate")(function* (client) {
      yield* client.handleServerRequest("account/chatgptAuthTokens/refresh", () =>
        fetchToken(true).pipe(Effect.map(toCodexTokenResponse)),
      );
      const token = yield* fetchToken(false);
      yield* client.request("account/login/start", {
        type: "chatgptAuthTokens",
        ...toCodexTokenResponse(token),
      });
    }),
  };
}
