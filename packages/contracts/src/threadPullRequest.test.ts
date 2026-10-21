import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ThreadPullRequestLink } from "./threadPullRequest.ts";

const decodeLinks = Schema.decodeUnknownEffect(Schema.Array(ThreadPullRequestLink));

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
