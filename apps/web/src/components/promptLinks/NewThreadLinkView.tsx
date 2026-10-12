import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { getCloneDestinationPath } from "@t3tools/client-runtime/operations/projects";
import {
  findPromptLinkProject,
  findPromptLinkPullRequestThread,
  resolvePromptLinkModelSelection,
} from "@t3tools/client-runtime/prompt-links";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  type NewThreadLink,
  type PromptLinkRepository,
  promptLinkPullRequestUrl,
} from "@t3tools/shared/promptLinks";
import { useAtomValue } from "@effect/atom-react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useEffectEvent, useRef, useState } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { isElectron } from "~/env";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useScratchProject } from "~/hooks/useScratchProject";
import { newProjectId } from "~/lib/utils";
import { useProjects, useThreadShells, waitForProject } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { allReachableShellsLiveAtom } from "~/state/shell";
import { sourceControlEnvironment } from "~/state/sourceControl";
import { useAtomCommand } from "~/state/use-atom-command";

import { usePullRequestHandoffs } from "../pullRequest/usePullRequestActions";
import { sortScopedProjectsForSidebar } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { placeLinkedPrompt, warnAboutHiddenCharacters } from "./linkedPrompt";

type LinkState =
  | { readonly status: "opening" }
  | { readonly status: "opened" }
  | { readonly status: "failed"; readonly message: string; readonly title?: string }
  | { readonly status: "missing-repository"; readonly repository: PromptLinkRepository }
  | {
      readonly status: "pull-request-checkout";
      readonly project: EnvironmentProject;
    };

// A link opens once per history entry. Going back to it lands here again, and opening a
// second draft for the same click would surprise more than it helps.
const openedLinkKeys = new Set<string>();

/**
 * The `/new` route: turns a prompt link into a draft holding its prompt, in the project the
 * link names (or "No project"), or into the thread behind a linked pull request. The user
 * still reads the prompt and presses Send.
 */
export function NewThreadLinkView({ link }: { readonly link: NewThreadLink }) {
  const locationKey = useLocation({ select: (location) => location.state.__TSR_key ?? "" });
  const navigate = useNavigate();
  // The link needs every reachable machine's projects and threads to find its repository.
  const ready = useAtomValue(allReachableShellsLiveAtom);
  const projects = useProjects();
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const handleNewThread = useNewThreadHandler();
  const { scratchEnvironmentId, openScratchProject } = useScratchProject();
  const startProjectClone = useAtomCommand(sourceControlEnvironment.startProjectClone, {
    reportFailure: false,
  });
  const [state, setState] = useState<LinkState>(() =>
    openedLinkKeys.has(locationKey) ? { status: "opened" } : { status: "opening" },
  );
  const startedRef = useRef(false);

  const recentProjects = () =>
    sortScopedProjectsForSidebar(
      projects.filter((project) => project.isScratch !== true),
      threads,
      "updated_at",
    );

  /** The machine the user worked on last, scratch threads included. */
  const lastActiveEnvironmentId = () => {
    let latest: (typeof threads)[number] | undefined;
    for (const thread of threads) {
      if (latest === undefined || thread.updatedAt > latest.updatedAt) latest = thread;
    }
    return latest?.environmentId ?? primaryEnvironmentId;
  };

  /** Opens a draft in the project with the link's prompt and, when it is available, model. */
  const openDraft = async (project: EnvironmentProject, extraPrompt?: string) => {
    const opened = await handleNewThread(scopeProjectRef(project.environmentId, project.id), {
      replace: true,
    }).catch(() => null);
    if (opened === null) {
      setState({ status: "failed", message: "T3 Code could not open a new thread." });
      return;
    }
    setState({ status: "opened" });
    const notes: Array<string> = [];
    if (link.kind === "new" && link.provider !== null) {
      const providers =
        environments.find((environment) => environment.environmentId === project.environmentId)
          ?.serverConfig?.providers ?? [];
      const resolved = resolvePromptLinkModelSelection(providers, {
        provider: link.provider,
        model: link.model,
      });
      if (resolved !== null) {
        useComposerDraftStore.getState().setModelSelection(opened.draftId, resolved.selection, {
          explicit: true,
          replaceOptions: true,
        });
      }
      if (resolved === null || !resolved.exact) {
        notes.push(
          resolved === null
            ? `The link asked for ${link.provider}, which is not set up here, so your default model is used.`
            : `The link asked for ${link.model}, which ${link.provider} does not offer here, so its default model is used.`,
        );
      }
    }
    const text = [link.prompt?.text, extraPrompt].filter(Boolean).join("\n\n");
    if (text.length === 0) return;
    placeLinkedPrompt(
      opened.draftId,
      { text, hiddenCharacters: link.prompt?.hiddenCharacters ?? 0 },
      notes,
    );
  };

  /** "No project" on the machine the user last worked on. */
  const openWithoutProject = async () => {
    setState({ status: "opening" });
    // The machine the user last worked on, or the only one that offers it.
    const environmentId =
      scratchEnvironmentId(lastActiveEnvironmentId()) ?? scratchEnvironmentId(null);
    // Reports its own failure.
    const project = environmentId === null ? null : await openScratchProject(environmentId);
    if (project === null) {
      setState({
        status: "failed",
        message: "None of your machines can start a thread without a project right now.",
      });
      return;
    }
    // Without its repository, a pull request link still says which one it meant.
    await openDraft(
      project,
      link.kind === "pull-request" ? promptLinkPullRequestUrl(link.pullRequest) : undefined,
    );
  };

  const cloneRepository = async (repository: PromptLinkRepository) => {
    const environmentId = lastActiveEnvironmentId();
    const environment = environments.find((entry) => entry.environmentId === environmentId);
    const newProjectsRoot = environment?.serverConfig?.newProjectsRoot ?? null;
    if (
      environmentId === null ||
      newProjectsRoot === null ||
      environment?.serverConfig?.environment.capabilities.projectCloneTracking !== true
    ) {
      setState({
        status: "failed",
        message:
          "This machine cannot clone from a link. Update T3 Code on it, or clone the repository from the command palette.",
      });
      return;
    }
    setState({ status: "opening" });
    const projectId = newProjectId();
    const result = await startProjectClone({
      environmentId,
      input: {
        projectId,
        title: repository.name,
        createdAt: new Date().toISOString(),
        remoteUrl: `https://github.com/${repository.owner}/${repository.name}.git`,
        destinationPath: getCloneDestinationPath(newProjectsRoot, repository.name),
      },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Clone failed",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
      setState({ status: "missing-repository", repository });
      return;
    }
    // The server adds the project at once and clones behind it. The draft shows the clone's
    // progress and holds Send until the code is there.
    const project = await waitForProject(scopeProjectRef(environmentId, projectId), 5_000).catch(
      () => null,
    );
    if (project === null) {
      setState({ status: "failed", message: "The clone started, but its project did not appear." });
      return;
    }
    // A pull request checks out from the cloned repository, which is not there yet.
    if (link.kind === "pull-request") {
      setState({
        status: "failed",
        title: `Cloning ${repository.owner}/${repository.name}`,
        message: "Open this link again when the clone finishes.",
      });
      return;
    }
    await openDraft(project);
  };

  const start = useEffectEvent(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    openedLinkKeys.add(locationKey);
    if (link.kind === "pull-request") {
      const thread = findPromptLinkPullRequestThread(threads, link.pullRequest);
      if (thread !== undefined) {
        setState({ status: "opened" });
        const threadRef = scopeThreadRef(thread.environmentId, thread.id);
        if (link.prompt !== null) placeLinkedPrompt(threadRef, link.prompt);
        void navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: thread.environmentId, threadId: thread.id },
          replace: true,
        });
        return;
      }
    }
    const repository = link.kind === "new" ? link.repository : link.pullRequest;
    if (repository === null) {
      void openWithoutProject();
      return;
    }
    const project = findPromptLinkProject(recentProjects(), repository);
    if (project === undefined) {
      setState({ status: "missing-repository", repository });
      return;
    }
    if (link.kind === "pull-request") {
      setState({ status: "pull-request-checkout", project });
      return;
    }
    void openDraft(project);
  });

  // Runs once per link, when the shells are in. Later shell updates must not open it again.
  useEffect(() => {
    if (ready && state.status === "opening") start();
  }, [ready, state.status]);

  switch (state.status) {
    case "opening":
      return <LinkPage title="Opening the link..." />;
    case "opened":
      return (
        <LinkPage title="This link is open">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              openedLinkKeys.delete(locationKey);
              startedRef.current = false;
              setState({ status: "opening" });
            }}
          >
            Open it again
          </Button>
        </LinkPage>
      );
    case "failed":
      return (
        <LinkPage title={state.title ?? "Could not open the link"} description={state.message} />
      );
    case "missing-repository": {
      const name = `${state.repository.owner}/${state.repository.name}`;
      return (
        <LinkPage
          title={`You don't have ${name}`}
          description="Clone it to work on it here, or start without a project."
        >
          <Button size="sm" onClick={() => void cloneRepository(state.repository)}>
            Clone {name}
          </Button>
          <Button size="sm" variant="outline" onClick={() => void openWithoutProject()}>
            Use without project
          </Button>
        </LinkPage>
      );
    }
    case "pull-request-checkout":
      return link.kind === "pull-request" ? (
        <PullRequestLinkCheckout link={link} project={state.project} />
      ) : null;
  }
}

/**
 * Asks, then checks the linked pull request out into its own worktree and opens a thread there.
 * The checkout runs the project's setup script on code from the pull request, so a link alone
 * never starts it.
 */
function PullRequestLinkCheckout({
  link,
  project,
}: {
  readonly link: Extract<NewThreadLink, { kind: "pull-request" }>;
  readonly project: EnvironmentProject;
}) {
  const { handoff, startHandoff } = usePullRequestHandoffs({
    environmentId: project.environmentId,
    detail: {
      projectId: project.id,
      workspaceRoot: project.workspaceRoot,
      url: promptLinkPullRequestUrl(link.pullRequest),
    },
  });
  const warnedRef = useRef(false);
  useEffect(() => {
    if (warnedRef.current || link.prompt === null) return;
    warnedRef.current = true;
    warnAboutHiddenCharacters(link.prompt);
  }, [link.prompt]);
  const { owner, name, number } = link.pullRequest;
  return (
    <LinkPage
      title={`Check out ${owner}/${name}#${number}?`}
      description="This puts the pull request's code in a new worktree and runs your project's setup script on it."
    >
      <Button
        size="sm"
        disabled={handoff !== null}
        // The checkout reports its own progress and says the task is in the composer.
        onClick={() =>
          void startHandoff(
            "prompt-link",
            link.prompt === null ? null : { prompt: link.prompt.text },
          )
        }
      >
        {handoff !== null ? "Checking out..." : "Check out"}
      </Button>
    </LinkPage>
  );
}

function LinkPage({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children?: ReactNode;
}) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      {isElectron ? <WorkspacePageHeader electron /> : null}
      <Empty className="flex-1">
        <EmptyHeader className="max-w-md">
          <EmptyTitle>{title}</EmptyTitle>
          {description ? <EmptyDescription>{description}</EmptyDescription> : null}
          {children ? <div className="mt-5 flex justify-center gap-2">{children}</div> : null}
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}
