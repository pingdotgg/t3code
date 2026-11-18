import { IssueTrackerKind, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadIssueService from "./ThreadIssueService.ts";

const THREAD_ID = ThreadId.make("thread-1");

describe("ThreadIssueService", () => {
  it.effect("fails an unlink whose thread cannot be read instead of reporting it unlinked", () =>
    Effect.gen(function* () {
      const service = yield* ThreadIssueService.ThreadIssueService;
      const error = yield* service
        .unlink({
          threadId: THREAD_ID,
          key: {
            tracker: IssueTrackerKind.make("github"),
            host: "github.com",
            scope: "t3tools/t3code",
            key: "7",
          },
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "OrchestratorProjectionError", threadId: THREAD_ID });
    }).pipe(
      Effect.provide(
        ThreadIssueService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(Orchestrator.OrchestratorV2)({
                getThreadShell: (threadId) =>
                  Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId })),
              }),
              Layer.succeed(
                SecureRandom.SecureRandom,
                SecureRandom.make((size) => new Uint8Array(size).fill(7)),
              ),
            ),
          ),
        ),
      ),
    ),
  );
});
