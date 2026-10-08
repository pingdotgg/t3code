// Run with: node apps/server/scripts/measure-pr-preview.ts owner/repo 123 456
// Numbers form a session with shared repository-permission caches. Browser and
// service caches are excluded. Uses real GitHub reads, without a server or database.
// Every GraphQL read carries `rateLimit`, so its cost is read off its own answer.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/http";

import * as GitHubPullRequestApi from "../src/pullRequest/GitHubPullRequestApi.ts";
import * as GitHubPullRequestProvider from "../src/pullRequest/GitHubPullRequestProvider.ts";
import * as GitHubApi from "../src/sourceControl/GitHubApi.ts";
import * as GitHubCredentials from "../src/sourceControl/GitHubCredentials.ts";
import * as ServerSettings from "../src/serverSettings.ts";
import * as GitHubGraphQlBudget from "../src/sourceControl/githubGraphQlBudget.ts";
import * as SourceControlRateLimit from "../src/sourceControl/SourceControlRateLimit.ts";
import * as VcsProcess from "../src/vcs/VcsProcess.ts";

const [repository, ...numbers] = process.argv.slice(2);
if (!repository || numbers.length === 0 || numbers.some((number) => !/^\d+$/.test(number))) {
  throw new Error("Usage: node apps/server/scripts/measure-pr-preview.ts owner/repo number...");
}

type Read = { graphqlRequests: number; restRequests: number; cost: number };
const reads: Read[] = [];
const decodeCost = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.Struct({ rateLimit: Schema.Struct({ cost: Schema.Number }) }),
    }),
  ),
);
const measuredApi = Layer.effect(
  GitHubApi.GitHubApi,
  Effect.gen(function* () {
    const api = yield* GitHubApi.make;
    return GitHubApi.GitHubApi.of({
      ...api,
      graphql: (input) =>
        api.graphql(input).pipe(
          Effect.tap((body) =>
            Effect.sync(() =>
              reads.push({
                graphqlRequests: 1,
                restRequests: 0,
                cost: Option.match(decodeCost(body), {
                  onNone: () => 0,
                  onSome: (decoded) => decoded.data.rateLimit.cost,
                }),
              }),
            ),
          ),
        ),
      rest: (input) =>
        api
          .rest(input)
          .pipe(
            Effect.tap(() =>
              Effect.sync(() => reads.push({ graphqlRequests: 0, restRequests: 1, cost: 0 })),
            ),
          ),
    });
  }),
).pipe(
  Layer.provide(GitHubCredentials.layer.pipe(Layer.provide(ServerSettings.layerTest()))),
  Layer.provide(GitHubGraphQlBudget.layer),
  Layer.provide(SourceControlRateLimit.layer),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(VcsProcess.layer),
  Layer.provide(NodeServices.layer),
);

const services = GitHubPullRequestApi.layer.pipe(
  Layer.provideMerge(measuredApi),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

for (const mode of ["detail", "preview"] as const) {
  // Start each side cold, then retain the caches shared across PRs in one session.
  const rows = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const provider = yield* GitHubPullRequestProvider.make;
        return yield* Effect.forEach(numbers.map(Number), (number) =>
          Effect.gen(function* () {
            const input = { cwd: process.cwd(), repository, host: "github.com", number };
            reads.length = 0;
            const start = performance.now();
            const value = yield* mode === "detail"
              ? provider.getChangeRequest(input)
              : provider.getChangeRequestPreview!(input);
            const elapsedMs = Math.round(performance.now() - start);
            const measured = [...reads];
            const points = measured.reduce((total, read) => total + read.cost, 0);
            return {
              repository,
              number,
              mode,
              state: value.state,
              elapsedMs,
              points,
              graphqlRequests: measured.reduce((total, read) => total + read.graphqlRequests, 0),
              restRequests: measured.reduce((total, read) => total + read.restRequests, 0),
            };
          }),
        );
      }),
    ).pipe(Effect.provide(services)),
  );
  for (const row of rows) await Effect.runPromise(Console.log(encodeJson(row)));
}
