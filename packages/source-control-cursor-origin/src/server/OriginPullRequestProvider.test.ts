import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as OriginCli from "./OriginCli.ts";
import * as OriginPullRequestProvider from "./OriginPullRequestProvider.ts";
import { checksState } from "./originPullRequests.ts";

const pullRequest = {
  number: 7,
  state: "open",
  title: "Many checks",
  head: { ref: "feature", sha: "abc123" },
  base: { ref: "main", sha: "def456" },
  webUrl: "https://cursor.com/origin/acme/repo/pull/7",
};

// Every check-run page is green and points at another page, so the read stops at its page cap.
const cliLayer = Layer.succeed(OriginCli.OriginCli, {
  execute: () => Effect.die("unexpected execute"),
  viewer: () => Effect.succeed("me"),
  personalNamespace: () => Effect.succeed("me"),
  resolveRepository: () => Effect.succeed("acme/repo"),
  api: (input, schema) => {
    const page = Number(new URL(input.path, "https://origin.test").searchParams.get("pageToken"));
    const body = input.path.includes("/check-runs")
      ? {
          checkRuns: [{ name: `check-${page}`, status: "completed", conclusion: "success" }],
          nextPageToken: String(page + 1),
        }
      : pullRequest;
    return Schema.decodeEffect(schema)(body).pipe(Effect.orDie);
  },
});

describe("OriginPullRequestProvider", () => {
  it.effect("does not report a check list cut off at the page cap as passing", () =>
    Effect.gen(function* () {
      const provider = yield* OriginPullRequestProvider.make;
      const { checks } = yield* provider.getChangeRequestChecks!({
        cwd: "/repo",
        repository: "acme/repo",
        host: "cursor.com",
        number: 7,
      });
      assert.notStrictEqual(checksState(checks), "passing");
    }).pipe(Effect.scoped, Effect.provide(cliLayer)),
  );
});
