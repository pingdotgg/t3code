import { ISSUE_LINKS_WS_METHODS, IssueLinksRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { IssueLinks } from "./IssueLinks.ts";

/** WebSocket handlers for the fork's Issue link RPCs, spread into the upstream RPC layer. */
export const makeIssueLinkRpcHandlers = Effect.gen(function* () {
  const links = yield* IssueLinks;
  return IssueLinksRpcGroup.of({
    [ISSUE_LINKS_WS_METHODS.forThread]: ({ threadId }) =>
      links.forThread(threadId).pipe(Effect.map((result) => ({ links: result }))),
    [ISSUE_LINKS_WS_METHODS.threadsForIssues]: (input) =>
      links.threadsForIssues(input).pipe(Effect.map((issues) => ({ issues }))),
    [ISSUE_LINKS_WS_METHODS.link]: (input) => links.link(input),
    [ISSUE_LINKS_WS_METHODS.unlink]: ({ threadId, ...issue }) => links.unlink({ threadId, issue }),
    [ISSUE_LINKS_WS_METHODS.subscribeChanges]: () => Stream.unwrap(links.subscribeChanges),
  });
});
