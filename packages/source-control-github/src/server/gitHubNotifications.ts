import type { ProviderChangeRequestNotifications } from "@t3tools/source-control-core/server/PullRequestProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type * as GitHubRest from "./GitHubRest.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";

const OPERATION = "listPullRequestNotifications";
const PAGE_SIZE = 50;

const decodeThreads = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        updated_at: Schema.String,
        subject: Schema.Struct({ type: Schema.String, url: Schema.NullOr(Schema.String) }),
      }),
    ),
  ),
);

/**
 * Reads without marking anything read. GitHub answers a conditional request with an unchanged
 * result as a 304 that costs no quota. Fine-grained and GitHub App tokens cannot read
 * notifications, so a refusal is null.
 */
export const makeListPullRequestNotifications = (rest: GitHubRest.GitHubRest["Service"]) =>
  Effect.fn("GitHubPullRequestApi.listPullRequestNotifications")(function* (input: {
    readonly host: string;
    readonly repository: string;
    readonly since: number;
  }) {
    const since = DateTime.makeUnsafe(Math.floor(input.since / 1000) * 1000);
    const response = yield* Effect.gen(function* () {
      const [read, personal] = yield* Effect.all([
        rest.credential(input.host),
        rest.credential(input.host, { personal: true }),
      ]);
      if (read.fingerprint !== personal.fingerprint) return null;
      return yield* rest.rest({
        host: input.host,
        operation: OPERATION,
        path: `repos/${input.repository}/notifications?all=true&participating=true&since=${DateTime.formatIso(since).replace(".000Z", "Z")}&per_page=${PAGE_SIZE}`,
        ifModifiedSince: DateTime.toDateUtc(since).toUTCString(),
        personal: true,
      });
    }).pipe(
      Effect.catchTags({
        GitHubApiNotFoundError: () => Effect.succeed(null),
        GitHubNotSignedInError: () => Effect.succeed(null),
        GitHubCliMissingError: () => Effect.succeed(null),
        GitHubApiResponseError: (error) =>
          error.status === 403 ? Effect.succeed(null) : Effect.fail(error),
      }),
    );
    if (response === null) return null;
    if (response.status === 304) {
      return { threads: [], truncated: false } satisfies ProviderChangeRequestNotifications;
    }
    const threads = yield* decodeThreads(response.body).pipe(
      Effect.mapError(
        () =>
          new GitHubRequestPolicy.GitHubApiResponseError({
            host: input.host,
            operation: OPERATION,
            status: response.status,
          }),
      ),
    );
    return {
      threads: threads.flatMap((thread) => {
        const number =
          thread.subject.type === "PullRequest"
            ? thread.subject.url?.match(/\/pulls\/(\d+)$/)
            : null;
        return number == null
          ? []
          : [{ number: Number(number[1]), updatedAt: Date.parse(thread.updated_at) }];
      }),
      truncated: threads.length >= PAGE_SIZE,
    } satisfies ProviderChangeRequestNotifications;
  });
