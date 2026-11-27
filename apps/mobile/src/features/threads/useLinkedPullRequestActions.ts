import {
  pullRequestLinkProject,
  resolveLinkPullRequestInput,
} from "@t3tools/client-runtime/pull-request-link-input";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  canStartThreadPullRequestWatch,
  planThreadPullRequestMutation,
} from "@t3tools/client-runtime/thread-pull-request-compatibility";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { changeRequestTermKind } from "../../lib/changeRequestTerm";
import { AuthOrchestrationOperateScope, type ThreadPullRequestLink } from "@t3tools/contracts";
import * as Clipboard from "expo-clipboard";
import { useGT } from "gt-react-native";

import * as Dialog from "../../components/ui/Dialog";
import { m } from "../../i18n/messages";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import type { MenuProps } from "../../components/ui/Menu.types";
import type { EnvironmentRuntimeState } from "../../state/remote-runtime-types";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

type MenuAction = MenuProps["actions"][number];

export function useLinkedPullRequestActions(input: {
  readonly thread: EnvironmentThreadShell | null;
  readonly project: EnvironmentProject | null;
  readonly runtime: EnvironmentRuntimeState | null;
}) {
  const gt = useGT();
  const { thread, project, runtime } = input;
  const terminology = sourceControlClients.get(project?.repositoryIdentity?.provider).changeRequest;
  const capabilities = runtime?.serverConfig?.environment.capabilities;
  const canOperate = useEnvironmentScope(
    thread?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const canEdit = canOperate && capabilities !== undefined;
  const canWatch = canOperate && capabilities?.threadPullRequestWatch === true;
  const canStartWatch = canWatch && thread !== null && canStartThreadPullRequestWatch(thread);
  const link = useAtomCommand(threadEnvironment.linkPullRequest, { reportFailure: false });
  const unlink = useAtomCommand(threadEnvironment.unlinkPullRequest, { reportFailure: false });
  const watch = useAtomCommand(threadEnvironment.watchPullRequest, { reportFailure: false });

  const run = async (
    failureTitle: string,
    pending: Promise<AtomCommandResult<unknown, unknown>>,
  ) => {
    const result = await pending;
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    const cause = squashAtomCommandFailure(result);
    Dialog.alert(failureTitle, errorDisplayMessage(cause, m) ?? gt("Try again."));
  };

  const setLinked = (
    reference: { host: string; repository: string; number: number; url: string },
    linked: boolean,
  ) => {
    if (thread === null) return;
    const mutation = planThreadPullRequestMutation({
      capabilities,
      threadId: thread.id,
      reference,
      linked,
    });
    if (mutation === null) return;
    const environmentId = thread.environmentId;
    void run(
      linked
        ? gt(
            "{term, select, mr {Couldn't link this merge request} cr {Couldn't link this change request} other {Couldn't link this pull request}}",
            { term: changeRequestTermKind(terminology) },
          )
        : gt(
            "{term, select, mr {Couldn't unlink this merge request} cr {Couldn't unlink this change request} other {Couldn't unlink this pull request}}",
            { term: changeRequestTermKind(terminology) },
          ),
      mutation.type === "thread.pull-request.link"
        ? link({ environmentId, input: mutation.input })
        : unlink({ environmentId, input: mutation.input }),
    );
  };

  const promptLink = () => {
    const term = changeRequestTermKind(terminology);
    Dialog.prompt({
      title: gt(
        "{term, select, mr {Link merge request} cr {Link change request} other {Link pull request}}",
        { term },
      ),
      message: gt(
        "{term, select, mr {Paste a merge request URL, or enter 123 / #123 for this thread's repository.} cr {Paste a change request URL, or enter 123 / #123 for this thread's repository.} other {Paste a pull request URL, or enter 123 / #123 for this thread's repository.}}",
        { term },
      ),
      placeholder: gt(
        "{term, select, mr {Merge request URL or #42} cr {Change request URL or #42} other {Pull request URL or #42}}",
        { term },
      ),
      initialValue: "",
      confirmText: gt("Link", { $context: "verb, confirms linking a pull request" }),
      onConfirm: (reference) => {
        const resolved = resolveLinkPullRequestInput(
          {
            reference,
            project: pullRequestLinkProject(project?.repositoryIdentity),
            hasProject: () => true,
          },
          m,
        );
        if (resolved === null) {
          Dialog.alert(
            gt(
              "{term, select, mr {Couldn't link this merge request} cr {Couldn't link this change request} other {Couldn't link this pull request}}",
              { term },
            ),
            gt(
              "{term, select, mr {Use a merge request URL, 123, or #123.} cr {Use a change request URL, 123, or #123.} other {Use a pull request URL, 123, or #123.}}",
              { term },
            ),
          );
          return;
        }
        if ("error" in resolved) {
          Dialog.alert(
            gt(
              "{term, select, mr {Couldn't link this merge request} cr {Couldn't link this change request} other {Couldn't link this pull request}}",
              { term },
            ),
            resolved.error,
          );
          return;
        }
        setLinked(resolved.link, true);
      },
    });
  };

  const menuActions = (link: ThreadPullRequestLink): MenuAction[] => {
    const open = link.snapshot === null || link.snapshot.state === "open";
    const watching = link.watch !== undefined;
    return [
      { id: "copy", title: gt("Copy link"), image: "link" },
      { id: "browser", title: gt("Open in browser"), image: "safari" },
      ...((watching ? canWatch : canStartWatch) && open
        ? [
            {
              id: "watch",
              title: watching ? gt("Stop watching") : gt("Watch for changes"),
              image: watching ? "eye.slash" : "eye",
            },
          ]
        : []),
      ...(canEdit
        ? [
            {
              id: "unlink",
              title: link.source === "stack" ? gt("Dismiss from thread") : gt("Unlink from thread"),
              image: "xmark",
              attributes: { destructive: true },
            },
          ]
        : []),
    ];
  };

  const onMenuAction = (link: ThreadPullRequestLink, action: string) => {
    if (action === "copy") void Clipboard.setStringAsync(link.url);
    else if (action === "browser")
      void tryOpenExternalUrl(link.url, "pull-request").then((opened) => {
        if (!opened) {
          const term = changeRequestTermKind(
            (
              sourceControlClients.findByChangeRequestUrl(link.url) ??
              sourceControlClients.get(undefined)
            ).changeRequest,
          );
          Dialog.alert(
            gt(
              "{term, select, mr {Unable to open MR} cr {Unable to open change request} other {Unable to open PR}}",
              { term },
            ),
            gt(
              "{term, select, mr {The merge request could not be opened.} cr {The change request could not be opened.} other {The pull request could not be opened.}}",
              { term },
            ),
          );
        }
      });
    else if (action === "watch" && thread !== null)
      void run(
        gt("Couldn't change watching"),
        watch({
          environmentId: thread.environmentId,
          input: {
            threadId: thread.id,
            host: link.host,
            repository: link.repository,
            number: link.number,
            watching: link.watch === undefined,
          },
        }),
      );
    else if (action === "unlink") setLinked(link, false);
  };

  return { canLink: canEdit, terminology, promptLink, menuActions, onMenuAction };
}

export type LinkedPullRequestActions = ReturnType<typeof useLinkedPullRequestActions>;
