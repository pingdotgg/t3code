// PRs share repository-permission caches; browser and service caches are excluded.
// GraphQL cost uses `x-ratelimit-used` deltas and includes concurrent use of the token.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient } from "effect/http";

import * as GitHubPullRequestApi from "@t3tools/source-control-github/server/GitHubPullRequestApi";
import * as GitHubPullRequestProvider from "@t3tools/source-control-github/server/GitHubPullRequestProvider";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as ServerConfig from "../src/config.ts";
import * as ServerSettings from "../src/serverSettings.ts";
import * as ServerSourceControlHost from "../src/sourceControl/ServerSourceControlHost.ts";
import * as GitVcsDriver from "../src/vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../src/vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../src/vcs/VcsProcess.ts";
import * as VcsProjectConfig from "../src/vcs/VcsProjectConfig.ts";

const [repository, ...numbers] = process.argv.slice(2);
if (!repository || numbers.length === 0 || numbers.some((number) => !/^\d+$/.test(number))) {
  throw new Error("Usage: node apps/server/scripts/measure-pr-preview.ts owner/repo number...");
}

type Read = { graphqlRequests: number; restRequests: number; cost: number };
const reads: Read[] = [];

let graphqlUsed: { used: number; reset: string } | null = null;
const decodeRateLimit = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      resources: Schema.Struct({
        graphql: Schema.Struct({ used: Schema.Number, reset: Schema.Number }),
      }),
    }),
  ),
);

// Count only increases in `used` so out-of-order answers do not double-count quota.
function graphqlCost(headers: Readonly<Record<string, string | undefined>>): number {
  const used = Number(headers["x-ratelimit-used"]);
  const reset = headers["x-ratelimit-reset"] ?? "";
  if (headers["x-ratelimit-resource"] !== "graphql" || !Number.isFinite(used)) return 0;
  const previous = graphqlUsed?.reset === reset ? graphqlUsed.used : 0;
  graphqlUsed = { used: Math.max(previous, used), reset };
  return Math.max(0, used - previous);
}

const measuredHttp = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return HttpClient.tap(client, (response) =>
      Effect.sync(() => {
        const graphql = new URL(response.request.url).pathname.endsWith("/graphql");
        reads.push({
          graphqlRequests: graphql ? 1 : 0,
          restRequests: graphql ? 0 : 1,
          cost: graphql ? graphqlCost(response.headers) : 0,
        });
      }),
    );
  }),
).pipe(Layer.provide(FetchHttpClient.layer));

const sourceControlHost = ServerSourceControlHost.layer.pipe(
  Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProjectConfig.layer))),
  Layer.provide(GitVcsDriver.layer),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-measure-pr-preview-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const services = GitHubPullRequestApi.layer.pipe(
  Layer.provideMerge(GitHubRest.layerWithDependencies),
  Layer.provideMerge(measuredHttp),
  Layer.provideMerge(sourceControlHost),
);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

for (const mode of ["detail", "preview"] as const) {
  const rows = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const provider = yield* GitHubPullRequestProvider.make;
        // `rate_limit` reads do not spend GraphQL quota.
        const api = yield* GitHubRest.GitHubRest;
        const limits = decodeRateLimit(
          (yield* api.rest({ host: "github.com", operation: "rateLimit", path: "rate_limit" }))
            .body,
        ).resources.graphql;
        graphqlUsed = { used: limits.used, reset: String(limits.reset) };
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
