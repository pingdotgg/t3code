import * as Effect from "effect/Effect";

import { IssueLinks } from "../../../issueLinks/IssueLinks.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { IssuesToolkit } from "./tools.ts";

// Issue links ride on the pull-request capability: both are the thread's source-control links.
const requireThread = McpInvocationContext.requireMcpCapability("pull-requests");

const make = Effect.gen(function* () {
  const links = yield* IssueLinks;
  return IssuesToolkit.of({
    link_issue: (target) =>
      Effect.gen(function* () {
        const { threadId } = yield* requireThread;
        const { link, alreadyLinked } = yield* links.link({ threadId, target, source: "agent" });
        return { ...link, alreadyLinked };
      }),
    unlink_issue: (target) =>
      Effect.gen(function* () {
        const { threadId } = yield* requireThread;
        const { url: _url, ...issue } = yield* links.resolveTarget(threadId, target);
        const { wasLinked } = yield* links.unlink({ threadId, issue });
        return { ...issue, wasLinked };
      }),
    list_thread_issues: () =>
      Effect.gen(function* () {
        const { threadId } = yield* requireThread;
        return { issues: yield* links.forThread(threadId) };
      }),
  });
});

export const IssuesToolkitHandlersLive = IssuesToolkit.toLayer(make);
