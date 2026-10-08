/**
 * HTTP transport for listing threads and stopping their runs (`/api/threads`),
 * used by `cz thread` on this machine and, with `--host`, on a paired one.
 *
 * @module ThreadControlHttp
 */
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  EnvironmentHttpApi,
  ThreadControlNotFoundError,
  ThreadId,
} from "@cz/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { threadSummaries } from "./summaries.ts";
import * as MorningBriefService from "./MorningBriefService.ts";
import * as ThreadDigestService from "./ThreadDigestService.ts";

export const threadsHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "threads",
  Effect.fnUntraced(function* (handlers) {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projects = yield* ProjectService.ProjectService;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const crypto = yield* Crypto.Crypto;
    const digests = yield* ThreadDigestService.ThreadDigestService;
    const briefs = yield* MorningBriefService.MorningBriefService;

    return handlers
      .handle("list", (args) =>
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* Effect.gen(function* () {
            const active = yield* projections.getShellSnapshot();
            const archived = yield* projections.getShellSnapshot({ location: "archive" });
            const snapshot = yield* projects.snapshot;
            return {
              threads: threadSummaries(
                [...active.threads, ...archived.threads],
                snapshot.projects,
                yield* Clock.currentTimeMillis,
              ),
            };
          }).pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
        }),
      )
      .handle("digests", (args) =>
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return { digests: yield* digests.digests(args.payload.threadIds) };
        }),
      )
      .handle("brief", (args) =>
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* briefs.brief;
        }),
      )
      .handle("briefSeen", (args) =>
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          yield* briefs.markSeen;
        }),
      )
      .handle("retry", (args) =>
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return { retried: yield* briefs.retry(args.payload.threadIds) };
        }),
      )
      .handle("stop", (args) =>
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const threadId = ThreadId.make(args.payload.threadId);
          const thread = yield* projections
            .getThreadShell(threadId)
            .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
          if (thread === null || thread.deletedAt !== null) {
            return yield* new ThreadControlNotFoundError({
              message: `No thread ${args.payload.threadId}.`,
            });
          }
          const result = yield* Effect.gen(function* () {
            return yield* threadManagement.interruptThread({
              projectId: thread.projectId,
              commandId: CommandId.make(`thread-stop:${yield* crypto.randomUUIDv4}`),
              threadId,
              reason: "Stopped with cz thread stop.",
            });
          }).pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
          return { status: result.type === "interrupt_requested" ? "stopping" : "idle" } as const;
        }),
      );
  }),
);
