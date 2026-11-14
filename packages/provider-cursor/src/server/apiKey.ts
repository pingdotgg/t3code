import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

export const DEFAULT_CURSOR_API_ENDPOINT = "https://api2.cursor.sh";

const ApiKeyExchange = Schema.Struct({ accessToken: Schema.NonEmptyString });

/** Trades a user API key for the access token Cursor's RPCs accept, as `@cursor/sdk` does. */
export const exchangeCursorApiKey = Effect.fn("exchangeCursorApiKey")(function* (apiKey: string) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(
    HttpClientRequest.post(`${DEFAULT_CURSOR_API_ENDPOINT}/auth/exchange_user_api_key`).pipe(
      HttpClientRequest.bearerToken(apiKey),
      HttpClientRequest.bodyJsonUnsafe({}),
    ),
  );
  const { accessToken } = yield* HttpClientResponse.schemaBodyJson(ApiKeyExchange)(
    yield* HttpClientResponse.filterStatusOk(response),
  );
  return accessToken;
}, Effect.timeout("10 seconds"));
