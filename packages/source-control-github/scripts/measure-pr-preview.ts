// Run with: node packages/source-control-github/scripts/measure-pr-preview.ts owner/repo 123 456 [--repeats=N]
// With --repeats, `elapsedMs` is the median, rows add `minMs` (fastest sample) and `repeats`, and
// request counts and `points` are totals across all samples.

// Real GitHub reads share repository-permission caches, excluding browser and service caches.
// HTTP client request counts are exact; GraphQL cost uses changes in `x-ratelimit-used`,
// which are approximate when other clients spend the same token's quota.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as GitHubAppAccess from "../src/server/GitHubAppAccess.ts";
import * as GitHubPullRequestApi from "../src/server/GitHubPullRequestApi.ts";
import * as GitHubPullRequestProvider from "../src/server/GitHubPullRequestProvider.ts";
import * as GitHubRest from "../src/server/GitHubRest.ts";
import * as FeatureFlags from "@t3tools/shared/FeatureFlags";

const repeatsFlag = process.argv.find((arg) => arg.startsWith("--repeats="));
const repeats = repeatsFlag === undefined ? 1 : Number(repeatsFlag.slice("--repeats=".length));
const [repository, ...numbers] = process.argv
  .slice(2)
  .filter((arg) => !arg.startsWith("--repeats="));
if (
  !repository ||
  numbers.length === 0 ||
  numbers.some((number) => !/^\d+$/.test(number)) ||
  !Number.isInteger(repeats) ||
  repeats < 1
) {
  throw new Error(
    "Usage: node packages/source-control-github/scripts/measure-pr-preview.ts owner/repo number... [--repeats=N]",
  );
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

// Default settings, so `gh` picks the account and no saved token applies. Only the credential
// lookup runs a process, and it needs no more than its output.
const sourceControlHost = Layer.unwrap(
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return TestSourceControlHost.layer({
      process: {
        run: (input) =>
          Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* spawner.spawn(
                ChildProcess.make(input.command, [...input.args], {
                  cwd: input.spawnCwd ?? input.cwd,
                  env: input.env,
                  extendEnv: true,
                }),
              );
              const [stdout, stderr, exitCode] = yield* Effect.all(
                [
                  Stream.mkString(Stream.decodeText(handle.stdout)),
                  Stream.mkString(Stream.decodeText(handle.stderr)),
                  handle.exitCode,
                ],
                { concurrency: "unbounded" },
              );
              return { exitCode, stdout, stderr, stdoutTruncated: false, stderrTruncated: false };
            }),
          ).pipe(Effect.orDie),
      },
    });
  }),
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const services = GitHubPullRequestApi.layer.pipe(
  Layer.provideMerge(GitHubAppAccess.layer),
  Layer.provideMerge(GitHubRest.layerWithDependencies),
  Layer.provideMerge(SourceControlRateLimit.layer),
  Layer.provideMerge(measuredHttp),
  Layer.provideMerge(sourceControlHost),
  Layer.provideMerge(FeatureFlags.layer),
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
            const samples: number[] = [];
            let state: string | undefined;
            const measured: Read[] = [];
            for (let run = 0; run < repeats; run += 1) {
              reads.length = 0;
              const start = performance.now();
              const value = yield* mode === "detail"
                ? provider.getChangeRequest(input)
                : provider.getChangeRequestPreview!(input);
              samples.push(Math.round(performance.now() - start));
              state = value.state;
              measured.push(...reads);
            }
            const sorted = [...samples].sort((a, b) => a - b);
            const mid = Math.floor(sorted.length / 2);
            const medianMs =
              sorted.length % 2 === 1
                ? (sorted[mid] ?? 0)
                : Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
            const points = measured.reduce((total, read) => total + read.cost, 0);
            return {
              repository,
              number,
              mode,
              state,
              elapsedMs: medianMs,
              ...(repeatsFlag === undefined ? {} : { minMs: sorted[0] ?? 0, repeats }),
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
