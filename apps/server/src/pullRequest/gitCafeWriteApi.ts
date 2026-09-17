import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type * as GitCafeCli from "../sourceControl/GitCafeCli.ts";
import { PullRequestProviderError, type ProviderRepositoryRef } from "./PullRequestProvider.ts";

/** Authenticated, repository-relative requests shared by GitCafe mutations. */
export function gitCafeWriteApi(cli: GitCafeCli.GitCafeCli["Service"]) {
  return <S extends Schema.Top & { readonly DecodingServices: never }>(
    input: ProviderRepositoryRef,
    path: string,
    schema: S,
    options: { readonly operation: string; readonly method?: string; readonly body?: unknown },
  ): Effect.Effect<S["Type"], PullRequestProviderError> => {
    const fail = (detail: string, cause?: unknown) =>
      new PullRequestProviderError({
        provider: "gitcafe",
        operation: options.operation,
        reason: "failed",
        detail,
        ...(cause === undefined ? {} : { cause }),
      });
    if (
      !["git.cafe", "staging.git.cafe"].includes(input.host) ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(input.repository)
    ) {
      return Effect.fail(fail("Invalid GitCafe repository or host."));
    }
    return cli
      .api({
        cwd: input.cwd,
        host: input.host,
        endpoint: `/repos/${input.repository.split("/").map(encodeURIComponent).join("/")}${path}`,
        ...(options.method === undefined ? {} : { method: options.method }),
        ...(options.body === undefined ? {} : { body: options.body }),
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new PullRequestProviderError({
              provider: "gitcafe",
              operation: options.operation,
              reason:
                cause.code === "CLI_UNAVAILABLE"
                  ? "missing-tool"
                  : cause.status === 401 || cause.code === "AUTHENTICATION_REQUIRED"
                    ? "unauthenticated"
                    : cause.status === 429 || cause.code === "RATE_LIMITED"
                      ? "rate-limited"
                      : "failed",
              detail: cause.detail,
              cause,
            }),
        ),
        Effect.flatMap((raw) =>
          Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
            Effect.mapError((cause) =>
              fail(
                "GitCafe returned an unreadable write response. Refresh before retrying; the operation may have succeeded.",
                cause,
              ),
            ),
          ),
        ),
      );
  };
}
