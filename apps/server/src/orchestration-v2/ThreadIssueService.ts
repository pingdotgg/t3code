/**
 * Issues linked to threads: the link and unlink commands the server's own surfaces (MCP) go
 * through. A link records how the tracker named the issue when it was made; nothing refreshes
 * it, and opening the issue reads its live state.
 *
 * @module orchestration-v2/ThreadIssueService
 */
import {
  CommandId,
  threadIssueKeysEqual,
  type IssueRef,
  type ThreadId,
  type ThreadIssueKey,
  type ThreadIssueLinkSource,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Orchestrator from "./Orchestrator.ts";

export interface LinkThreadIssueInput {
  readonly threadId: ThreadId;
  readonly ref: IssueRef & { readonly host: string };
  readonly url: string;
  readonly displayKey: string;
  readonly title: string;
  readonly source: ThreadIssueLinkSource;
}

export interface UnlinkThreadIssueInput {
  readonly threadId: ThreadId;
  readonly key: ThreadIssueKey;
}

export class ThreadIssueService extends Context.Service<
  ThreadIssueService,
  {
    /** Linking a linked issue is a no-op. */
    readonly link: (
      input: LinkThreadIssueInput,
    ) => Effect.Effect<{ readonly alreadyLinked: boolean }, Orchestrator.OrchestratorV2Error>;
    readonly unlink: (
      input: UnlinkThreadIssueInput,
    ) => Effect.Effect<{ readonly wasLinked: boolean }, Orchestrator.OrchestratorV2Error>;
  }
>()("t3/orchestration-v2/ThreadIssueService") {}

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const random = yield* SecureRandom.SecureRandom;

  const commandId = (tag: string, threadId: ThreadId) =>
    random.uuidV4().pipe(
      Effect.orDie,
      Effect.map((uuid) => CommandId.make(`server:thread-issue-${tag}:${threadId}:${uuid}`)),
    );

  const isLinked = (threadId: ThreadId, key: ThreadIssueKey) =>
    orchestrator.getThreadShell(threadId).pipe(
      Effect.map(
        (thread) => thread?.issues?.some((link) => threadIssueKeysEqual(link, key)) === true,
      ),
      Effect.orElseSucceed(() => false),
    );

  const link: ThreadIssueService["Service"]["link"] = Effect.fn("ThreadIssueService.link")(
    function* (input) {
      if (yield* isLinked(input.threadId, input.ref)) return { alreadyLinked: true };
      yield* orchestrator.dispatch({
        type: "thread.issue.link",
        commandId: yield* commandId("link", input.threadId),
        threadId: input.threadId,
        tracker: input.ref.tracker,
        host: input.ref.host,
        scope: input.ref.scope,
        key: input.ref.key,
        projectId: input.ref.projectId,
        url: input.url,
        displayKey: input.displayKey,
        title: input.title,
        source: input.source,
      });
      return { alreadyLinked: false };
    },
  );

  const unlink: ThreadIssueService["Service"]["unlink"] = Effect.fn("ThreadIssueService.unlink")(
    function* (input) {
      if (!(yield* isLinked(input.threadId, input.key))) return { wasLinked: false };
      yield* orchestrator.dispatch({
        type: "thread.issue.unlink",
        commandId: yield* commandId("unlink", input.threadId),
        threadId: input.threadId,
        tracker: input.key.tracker,
        host: input.key.host,
        scope: input.key.scope,
        key: input.key.key,
      });
      return { wasLinked: true };
    },
  );

  return ThreadIssueService.of({ link, unlink });
});

export const layer = Layer.effect(ThreadIssueService, make);
