import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ThreadPullRequestLink } from "./threadPullRequest.ts";

const decodeLinks = Schema.decodeUnknownEffect(Schema.Array(ThreadPullRequestLink));

it.effect("decodes thread pull request links with snapshot and stack", () =>
  Effect.gen(function* () {
    const links = yield* decodeLinks([
      {
        host: "github.com",
        repository: "pingdotgg/t3code",
        number: 42,
        url: "https://github.com/pingdotgg/t3code/pull/42",
        source: "agent",
        linkedAt: "2026-01-01T00:00:00.000Z",
        snapshot: null,
        stack: null,
      },
      {
        host: "github.com",
        repository: "pingdotgg/t3code",
        number: 43,
        url: "https://github.com/pingdotgg/t3code/pull/43",
        source: "stack",
        linkedAt: "2026-01-01T00:01:00.000Z",
        snapshot: {
          state: "open",
          title: "Layer two",
          headBranch: "feature/stack-2",
          baseBranch: "feature/stack-1",
          isDraft: false,
          updatedAt: "2026-01-01T00:02:00.000Z",
          syncedAt: "2026-01-01T00:03:00.000Z",
        },
        stack: {
          kind: "native",
          id: "7",
          number: 3,
          url: "https://github.com/pingdotgg/t3code/stacks/3",
          base: "main",
          layers: [
            { number: 42, headBranch: "feature/stack-1", state: "open" },
            { number: 43, headBranch: "feature/stack-2", state: "open" },
          ],
        },
      },
    ]);

    assert.strictEqual(links.length, 2);
    assert.strictEqual(links[1]?.stack?.layers.length, 2);
    assert.strictEqual(links[1]?.snapshot?.state, "open");
  }),
);

it.effect("decodes a watch saved before passed checks were recorded", () =>
  Effect.gen(function* () {
    const [link] = yield* decodeLinks([
      {
        host: "github.com",
        repository: "pingdotgg/t3code",
        number: 42,
        url: "https://github.com/pingdotgg/t3code/pull/42",
        source: "agent",
        linkedAt: "2026-01-01T00:00:00.000Z",
        snapshot: null,
        stack: null,
        watch: {
          startedAt: "2026-01-01T00:00:00.000Z",
          headSha: "abc123",
          failedChecks: [],
          passed: true,
          remarksThrough: "2026-01-01T00:00:00.000Z",
          remarkIds: [],
          conflicting: false,
          wakes: 0,
        },
      },
    ]);

    assert.deepStrictEqual(link?.watch?.passedChecks, []);
  }),
);
