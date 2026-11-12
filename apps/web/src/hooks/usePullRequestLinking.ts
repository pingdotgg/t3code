import type { EnvironmentId, ScopedThreadRef, ThreadPullRequestLink } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  planThreadPullRequestMutation,
  threadPullRequestLinkMode,
} from "@t3tools/client-runtime/thread-pull-request-compatibility";
import {
  threadPullRequestKeysEqual,
  visibleThreadPullRequests,
} from "@t3tools/client-runtime/thread-pull-requests";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentServerConfigsAtom } from "~/state/server";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

// A primitive mode prevents unchanged status pushes from re-rendering every link.
const linkModeAtom = Atom.family((environmentId: EnvironmentId | null) =>
  Atom.make((get) =>
    threadPullRequestLinkMode(
      environmentId === null
        ? undefined
        : get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities,
    ),
  ).pipe(Atom.withLabel("pull-request-link-mode")),
);

export function usePullRequestLinking(environmentId: EnvironmentId | null | undefined) {
  const mode = useAtomValue(linkModeAtom(environmentId ?? null));
  const link = useAtomCommand(threadEnvironment.linkPullRequest, { reportFailure: false });
  const unlink = useAtomCommand(threadEnvironment.unlinkPullRequest, { reportFailure: false });
  const canLink = (url: string) =>
    mode !== "unsupported" && sourceControlClients.parseChangeRequestUrl(url) !== null;
  const isLinked = (
    thread: { readonly pullRequests?: readonly ThreadPullRequestLink[] } | null,
    url: string,
  ) => {
    if (thread === null || mode === "unsupported") return false;
    const parsed = sourceControlClients.parseChangeRequestUrl(url)?.link;
    return (
      parsed !== undefined &&
      visibleThreadPullRequests(thread.pullRequests ?? []).some((entry) =>
        threadPullRequestKeysEqual(entry, parsed),
      )
    );
  };
  const changeLink = async (threadRef: ScopedThreadRef, url: string, linked: boolean) => {
    const parsed = sourceControlClients.parseChangeRequestUrl(url)?.link;
    if (
      parsed === undefined ||
      threadRef.environmentId !== environmentId ||
      (linked && !canLink(url))
    )
      throw new Error("The pull request is not available in this environment.");
    const mutation = planThreadPullRequestMutation({
      capabilities: appAtomRegistry.get(environmentServerConfigsAtom).get(threadRef.environmentId)
        ?.environment.capabilities,
      threadId: threadRef.threadId,
      reference: { ...parsed, url },
      linked,
    });
    if (mutation === null)
      throw new Error("This environment does not support linking this pull request.");
    const result = await (mutation.type === "thread.pull-request.link"
      ? link({ environmentId: threadRef.environmentId, input: mutation.input })
      : unlink({ environmentId: threadRef.environmentId, input: mutation.input }));
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) throw new Error("Link update interrupted.");
      throw squashAtomCommandFailure(result);
    }
  };
  return { mode, canLink, isLinked, changeLink };
}
