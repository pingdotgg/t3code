import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ClosingReferences from "./closingReferences.ts";
import { IssueLinks, layer as issueLinksLayer } from "./IssueLinks.ts";
import {
  closingReferencesLive,
  insertProject,
  insertPullRequestLink,
  insertThread,
  projectionLayer,
} from "./IssueLinks.testFixtures.ts";

/**
 * Reads real GitHub through the real `gh`. Opt in with `T3_LIVE_GITHUB=1` and a signed-in `gh`
 * (or `GH_TOKEN`). Fixture: toolboxmd/t3code PR #16 closes Issue #15.
 */
const live = process.env.T3_LIVE_GITHUB === "1";
const CHECKOUT = process.cwd();

describe.skipIf(!live)("IssueLinks against GitHub", () => {
  it.effect("reads the Issues a pull request closes", () =>
    Effect.gen(function* () {
      const references = yield* ClosingReferences.IssueClosingReferences;
      const closed = yield* references.issuesClosedBy({
        pullRequest: { host: "github.com", repository: "toolboxmd/t3code", number: 16 },
        version: null,
        cwd: CHECKOUT,
      });
      expect(closed).toContainEqual({
        host: "github.com",
        repository: "toolboxmd/t3code",
        number: 15,
      });
    }).pipe(Effect.provide(closingReferencesLive)),
  );

  it.effect("links a thread to the Issues its pull request closes", () =>
    Effect.gen(function* () {
      const thread = ThreadId.make("thread-live");
      yield* insertProject("project-fork", CHECKOUT);
      yield* insertThread({ id: thread, projectId: "project-fork" });
      yield* insertPullRequestLink({
        threadId: thread,
        repository: "toolboxmd/t3code",
        number: 16,
      });
      const links = yield* IssueLinks;
      expect(yield* links.forThread(thread)).toContainEqual({
        host: "github.com",
        repository: "toolboxmd/t3code",
        number: 15,
        url: "https://github.com/toolboxmd/t3code/issues/15",
        sources: ["closing-reference"],
        linkedAt: null,
      });
      // The Issues list passes the closing pull requests its GraphQL page already read.
      expect(
        yield* links.threadsForIssues({
          issues: [
            {
              host: "github.com",
              repository: "toolboxmd/t3code",
              number: 15,
              closingPullRequests: [{ repository: "toolboxmd/t3code", number: 16 }],
            },
          ],
        }),
      ).toMatchObject([{ number: 15, threads: [{ id: thread, sources: ["closing-reference"] }] }]);
    }).pipe(
      Effect.provide(
        issueLinksLayer.pipe(
          Layer.provideMerge(projectionLayer({ [CHECKOUT]: "toolboxmd/t3code" })),
          Layer.provide(closingReferencesLive),
          Layer.provideMerge(SqlitePersistenceMemory),
        ),
      ),
    ),
  );
});
