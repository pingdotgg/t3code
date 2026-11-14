import { PositiveInt, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { GraphQLClient, GraphQLClientError, GraphQLGroup } from "effect/graphql";

import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubGraphQlClient from "./gitHubGraphQlClient.ts";
import { RoutingIdentityViewer } from "./pullRequestReads.graphql.ts";

class GitHubViewerResponseError extends Schema.TaggedError<GitHubViewerResponseError>()(
  "GitHubViewerResponseError",
  { host: Schema.String, operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return "GitHub returned an invalid authenticated viewer identity.";
  }
}

const group = GraphQLGroup.make(RoutingIdentityViewer).middleware(
  GitHubGraphQlClient.GitHubGraphQlAuth,
);

const Viewer = Schema.Struct({
  login: TrimmedNonEmptyString,
  id: PositiveInt,
});
const decodeRestViewer = Schema.decodeUnknownEffect(Schema.fromJsonString(Viewer));
const decodeViewer = Schema.decodeUnknownEffect(Viewer);

/** REST rejects installation tokens; GraphQL verifies their bot using the same credential. */
export const makeGitHubViewerReader = Effect.gen(function* () {
  const api = yield* GitHubRest.GitHubRest;
  const client = yield* GraphQLClient.make(group).pipe(Effect.provide(GitHubGraphQlClient.layer));
  return Effect.fn("GitHubViewer.read")(function* (input: {
    readonly host: string;
    readonly operation: string;
    readonly allowReserve?: boolean;
  }) {
    return yield* api.rest({ ...input, path: "user" }).pipe(
      Effect.flatMap((response) => decodeRestViewer(response.body)),
      Effect.catchIf(
        (error) => error._tag === "GitHubApiResponseError" && error.status === 403,
        () =>
          client.RoutingIdentityViewer({}).pipe(
            GitHubGraphQlClient.call(input),
            Effect.flatMap((result) =>
              decodeViewer({ id: result.viewer.databaseId, login: result.viewer.login }),
            ),
          ),
      ),
      Effect.mapError((error) =>
        error._tag === "SchemaError" || GraphQLClientError.isGraphQLClientError(error)
          ? new GitHubViewerResponseError({
              host: input.host,
              operation: input.operation,
              cause: error,
            })
          : error,
      ),
    );
  });
});
