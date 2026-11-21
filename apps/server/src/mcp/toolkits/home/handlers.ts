import {
  type HomeError,
  type HomeWatchTarget,
  OrchestratorMcpFailure,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as HomeService from "../../../home/HomeService.ts";
import { requireHomeCaller } from "../../homeAccess.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { HomeToolkit } from "./tools.ts";

const toFailure = (error: HomeError) =>
  new OrchestratorMcpFailure({
    code: error.reason === "not-home" ? "capability_denied" : "orchestration_error",
    message: error.message,
  });

const targetOf = (input: {
  readonly threadId?: ThreadId | undefined;
  readonly workflowRunId?: string | undefined;
}): Effect.Effect<HomeWatchTarget, OrchestratorMcpFailure> => {
  if (input.threadId !== undefined && input.workflowRunId === undefined) {
    return Effect.succeed({ threadId: input.threadId });
  }
  if (input.workflowRunId !== undefined && input.threadId === undefined) {
    return Effect.succeed({ workflowRunId: input.workflowRunId });
  }
  return Effect.fail(
    new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "Give exactly one of `threadId` or `workflowRunId`.",
    }),
  );
};

export const layer = McpToolAccess.toLayer(HomeToolkit, {
  home_notes_read: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      yield* requireHomeCaller();
      const home = yield* HomeService.HomeService;
      return { text: yield* home.readNotes.pipe(Effect.mapError(toFailure)) };
    }),
  ),
  home_notes_write: McpToolAccess.actsAsCaller(({ text }) =>
    Effect.gen(function* () {
      yield* requireHomeCaller();
      const home = yield* HomeService.HomeService;
      yield* home.writeNotes(text).pipe(Effect.mapError(toFailure));
      return {};
    }),
  ),
  home_watch_add: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const homeThreadId = yield* requireHomeCaller();
      const target = yield* targetOf(input);
      const home = yield* HomeService.HomeService;
      const watches = yield* home
        .addWatch(homeThreadId, { ...target, reason: "manual" })
        .pipe(Effect.mapError(toFailure));
      return { watches };
    }),
  ),
  home_watch_remove: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const homeThreadId = yield* requireHomeCaller();
      const target = yield* targetOf(input);
      const home = yield* HomeService.HomeService;
      const watches = yield* home
        .removeWatch(homeThreadId, target)
        .pipe(Effect.mapError(toFailure));
      return { watches };
    }),
  ),
  home_watch_list: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      yield* requireHomeCaller();
      const home = yield* HomeService.HomeService;
      const { watches } = yield* home.read.pipe(Effect.mapError(toFailure));
      return { watches };
    }),
  ),
});
