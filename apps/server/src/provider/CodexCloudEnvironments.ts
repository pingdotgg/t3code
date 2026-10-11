import {
  ProviderDriverKind,
  type ProviderCloudEnvironment,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

const isProviderDriverError = Schema.is(ProviderDriverError);

const NativeAuth = Schema.Struct({
  tokens: Schema.Struct({
    access_token: Schema.NonEmptyString,
    account_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
});
const decodeAuth = Schema.decodeUnknownEffect(Schema.fromJsonString(NativeAuth));
const Environments = Schema.Array(
  Schema.Struct({
    id: Schema.NonEmptyString,
    label: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
);

/** Uses the same account and discovery endpoints as `codex cloud`, keeping auth on the host. */
export const makeCodexCloudEnvironments = Effect.fn("makeCodexCloudEnvironments")(function* (
  instanceId: ProviderInstanceId,
  homePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const error = (detail: string) =>
    new ProviderDriverError({
      driver: ProviderDriverKind.make("codex"),
      instanceId,
      detail,
    });

  const decodeEnvironments = Schema.decodeUnknownEffect(Environments);
  return (
    repository?: string,
  ): Effect.Effect<ReadonlyArray<ProviderCloudEnvironment>, ProviderDriverError> =>
    Effect.gen(function* () {
      const auth = yield* fs.readFileString(path.join(homePath, "auth.json")).pipe(
        Effect.flatMap(decodeAuth),
        Effect.mapError(() =>
          error("Sign in to Codex with ChatGPT to choose a cloud environment."),
        ),
      );
      const list = (suffix: string) =>
        Effect.gen(function* () {
          let request = HttpClientRequest.get(
            `https://chatgpt.com/backend-api/wham/environments${suffix}`,
          ).pipe(
            HttpClientRequest.bearerToken(auth.tokens.access_token),
            HttpClientRequest.setHeader("User-Agent", "t3code"),
          );
          if (auth.tokens.account_id)
            request = request.pipe(
              HttpClientRequest.setHeader("ChatGPT-Account-Id", auth.tokens.account_id),
            );
          const response = yield* http
            .execute(request)
            .pipe(
              Effect.mapError(() =>
                error("Could not load Codex Cloud environments. Try refreshing."),
              ),
            );
          if (response.status === 401 || response.status === 403)
            return yield* error(
              "Check your Codex sign-in and cloud access, then refresh environments.",
            );
          if (response.status < 200 || response.status >= 300)
            return yield* error("Could not load Codex Cloud environments. Try refreshing.");
          return yield* response.json.pipe(
            Effect.flatMap(decodeEnvironments),
            Effect.mapError(() =>
              error("Codex returned an unreadable environment list. Try refreshing."),
            ),
          );
        });
      const all = yield* list("");
      // A repository lookup is only a suggestion. Failure must not hide the global list.
      const matching = repository
        ? yield* list(
            `/by-repo/github/${repository.split("/").map(encodeURIComponent).join("/")}`,
          ).pipe(Effect.orElseSucceed(() => []))
        : [];
      const matchingIds = new Set(matching.map((environment) => environment.id));
      return [
        ...new Map(
          [...all, ...matching].map((environment) => [environment.id, environment]),
        ).values(),
      ]
        .map((environment) => ({
          id: environment.id,
          label: environment.label?.trim() || environment.id,
          ...(repository && matchingIds.has(environment.id) ? { repository } : {}),
        }))
        .sort(
          (a, b) =>
            Number(Boolean(b.repository)) - Number(Boolean(a.repository)) ||
            a.label.localeCompare(b.label),
        );
    }).pipe(
      Effect.timeout("15 seconds"),
      Effect.mapError((cause) =>
        isProviderDriverError(cause)
          ? cause
          : error("Loading Codex Cloud environments timed out. Try refreshing."),
      ),
      Effect.scoped,
    );
});
