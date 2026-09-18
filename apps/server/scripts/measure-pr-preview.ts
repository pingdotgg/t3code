// Run with: node apps/server/scripts/measure-pr-preview.ts owner/repo 123 456
// Numbers form a session with shared repository-permission caches. Browser and
// service caches are excluded. Uses real GitHub reads, without a server or database.
// CLI-generated GraphQL
// queries are replayed with rateLimit.cost, outside the timed section, to measure
// their cost without confusing other applications' traffic with this process's.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as GitHubPullRequestCli from "../src/pullRequest/GitHubPullRequestCli.ts";
import * as GitHubPullRequestProvider from "../src/pullRequest/GitHubPullRequestProvider.ts";
import * as GitHubCli from "../src/sourceControl/GitHubCli.ts";
import * as VcsProcess from "../src/vcs/VcsProcess.ts";

const [repository, ...numbers] = process.argv.slice(2);
if (!repository || numbers.length === 0 || numbers.some((number) => !/^\d+$/.test(number))) {
  throw new Error("Usage: node apps/server/scripts/measure-pr-preview.ts owner/repo number...");
}

type Read = { graphqlRequests: number; restRequests: number; cost: number; debug: string };
const reads: Read[] = [];
const measuredProcess = Layer.effect(
  VcsProcess.VcsProcess,
  Effect.gen(function* () {
    const vcs = yield* VcsProcess.VcsProcess;
    return VcsProcess.VcsProcess.of({
      run: (input) =>
        vcs.run({ ...input, env: { ...input.env, GH_DEBUG: input.env?.GH_DEBUG ?? "api" } }).pipe(
          Effect.tap((output) =>
            Effect.sync(() => {
              const graphqlRequests = [...output.stderr.matchAll(/^> POST \/graphql /gm)].length;
              const requests = [...output.stderr.matchAll(/^> (?:GET|POST) /gm)].length;
              const cost = /"rateLimit"\s*:\s*\{[^}]*"cost"\s*:\s*(\d+)/.exec(output.stdout)?.[1];
              reads.push({
                graphqlRequests,
                restRequests: requests - graphqlRequests,
                cost: Number(cost ?? 0),
                debug: output.stderr,
              });
            }),
          ),
        ),
    });
  }),
).pipe(Layer.provide(VcsProcess.layer), Layer.provide(NodeServices.layer));

const services = GitHubPullRequestCli.layer.pipe(
  Layer.provide(GitHubCli.layer),
  Layer.provideMerge(measuredProcess),
);

const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const graphqlCost = Effect.fn("measurePrPreview.graphqlCost")(function* (read: Read) {
  // The REST quota probe synthesizes rateLimit.cost for budget admission.
  // It does not spend GraphQL points.
  if (!read.graphqlRequests) return 0;
  if (read.cost) return read.cost;
  const vcs = yield* VcsProcess.VcsProcess;
  let cost = 0;
  let found = 0;
  for (const match of read.debug.matchAll(
    /GraphQL query:\n([\s\S]*?)\nGraphQL variables: (\{[^\n]*\})/g,
  )) {
    const query = match[1]!.replace(/(\bquery\b[^{]*\{)/, "$1 rateLimit { cost }");
    const output = yield* vcs.run({
      operation: "measurePrPreview.cost",
      command: "gh",
      cwd: process.cwd(),
      args: [
        "api",
        "graphql",
        "--hostname",
        "github.com",
        "--input",
        "-",
        "--jq",
        ".data.rateLimit.cost",
      ],
      stdin: encodeJson({ query, variables: decodeJson(match[2]!) }),
      env: { GH_DEBUG: "" },
    });
    cost += Number(output.stdout.trim());
    found++;
  }
  if (found !== read.graphqlRequests)
    throw new Error("Could not account for every GraphQL request");
  return cost;
});

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
            const costs = yield* Effect.forEach(measured, graphqlCost);
            const points = costs.reduce((total, cost) => total + cost, 0);
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
