import type {
  ExecutionEnvironmentCapabilities,
  ThreadId,
  ThreadPullRequestKey,
} from "@t3tools/contracts";
import { normalizeThreadPullRequestKey } from "./threadPullRequests.ts";

/** "unsupported" until the environment's server config has loaded. */
export function threadPullRequestLinkMode(
  capabilities: ExecutionEnvironmentCapabilities | null | undefined,
) {
  return capabilities ? ("multiple" as const) : ("unsupported" as const);
}

export function planThreadPullRequestMutation({
  capabilities,
  threadId,
  reference,
  linked,
}: {
  capabilities: ExecutionEnvironmentCapabilities | null | undefined;
  threadId: ThreadId;
  reference: ThreadPullRequestKey & { readonly url: string };
  linked: boolean;
}) {
  const key = normalizeThreadPullRequestKey(reference);
  switch (threadPullRequestLinkMode(capabilities)) {
    case "multiple":
      return linked
        ? {
            type: "thread.pull-request.link" as const,
            input: { threadId, ...reference, ...key, source: "manual" as const },
          }
        : {
            type: "thread.pull-request.unlink" as const,
            input: {
              threadId,
              ...key,
            },
          };
    case "unsupported":
      return null;
  }
}
