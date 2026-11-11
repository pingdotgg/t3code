import { CursorCloudError } from "@t3tools/contracts";
import type { ProviderCloudAccess } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type { CursorAuth } from "./auth.ts";

const apiBase = "https://api.cursor.com/v1";
export const makeCursorCloudAccess = Effect.fn("makeCursorCloudAccess")(function* (
  auth: Pick<CursorAuth, "requireApiKey" | "withAccess">,
) {
  const http = yield* HttpClient.HttpClient;
  const request = Effect.fn("CursorCloud.request")(function* <A, I>(
    key: string,
    path: string,
    schema: Schema.Codec<A, I>,
  ) {
    const req = HttpClientRequest.make("GET")(`${apiBase}${path}`).pipe(
      HttpClientRequest.bearerToken(key),
    );
    const response = yield* http.execute(req).pipe(
      Effect.timeout("30 seconds"),
      Effect.mapError(() => new CursorCloudError({ reason: "request" })),
    );
    if (response.status < 200 || response.status >= 300)
      return yield* new CursorCloudError({ reason: "request", status: response.status });
    const json = yield* response.json.pipe(
      Effect.mapError(() => new CursorCloudError({ reason: "response" })),
    );
    return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
      Effect.mapError(() => new CursorCloudError({ reason: "response" })),
    );
  });
  const call = Effect.fn("CursorCloud.call")(function* <A, I>(
    path: string,
    schema: Schema.Codec<A, I>,
  ) {
    return yield* auth.requireApiKey.pipe(
      Effect.flatMap((key) => request(key, path, schema)),
      auth.withAccess,
      Effect.scoped,
      Effect.catchTags({
        ProviderSetupError: () => Effect.fail(new CursorCloudError({ reason: "authentication" })),
      }),
    );
  });
  return {
    check: call("/me", Schema.Struct({ userEmail: Schema.String })).pipe(Effect.asVoid),
  } satisfies ProviderCloudAccess;
});
