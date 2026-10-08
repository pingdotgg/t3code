import { changeRequestUrlFor as changeRequestWebUrl } from "@t3tools/shared/changeRequestUrl";
export { changeRequestUrlFor as changeRequestWebUrl } from "@t3tools/shared/changeRequestUrl";
import {
  type EnvironmentId,
  normalizeWorkItemLinkKey,
  pullRequestHostOf,
  type IssueRef,
  type ProjectId,
  type ScopedThreadRef,
  type SourceControlProviderKind,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { findProjectForIssue, repositoryForProjectLink } from "~/lib/openIssueLink";
import {
  findProjectOnChangeRequestHost,
  parseChangeRequestUrl,
  resolvePullRequestPreviewTarget,
} from "~/lib/openPullRequestLink";
import { parsePullRequestReference } from "~/pullRequestReference";
import { useProjects, useServerConfigs, useThreadShell } from "~/state/entities";
import { issueEnvironment } from "~/state/issues";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useDebouncedValue } from "~/state/queries";
import { useEnvironmentQuery } from "~/state/query";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { usePullRequestLinking } from "~/hooks/usePullRequestLinking";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { Atom } from "effect/reactivity";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { PULL_REQUEST_STATE_PRESENTATION } from "./pullRequestIcons";

/**
 * Which thread has the link dialog open, set by whichever entry point asked (command palette,
 * pull-requests surface, detail panel) and rendered once by the chat view so the dialog outlives
 * a palette that closes the moment its command runs.
 */
const linkPullRequestDialogThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("pull-requests:link-dialog-thread"),
);

export function openLinkPullRequestDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(linkPullRequestDialogThreadAtom, threadRef);
}

interface LinkPullRequestDialogProps {
  open: boolean;
  threadRef: ScopedThreadRef;
  /** The thread's own project: bare numbers resolve against its repository. */
  projectId: string | null;
  issuesSupported: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Mounted once per chat view; shows the dialog for whichever thread asked for it. */
export function LinkPullRequestDialogHost() {
  const threadRef = useAtomValue(linkPullRequestDialogThreadAtom);
  const thread = useThreadShell(threadRef);
  const linking = usePullRequestLinking(threadRef?.environmentId);
  const configs = useServerConfigs();
  const issuesSupported =
    threadRef !== null &&
    configs.get(threadRef.environmentId)?.environment.capabilities.issues === true;
  if (threadRef === null || (linking.mode === "unsupported" && !issuesSupported)) return null;
  return (
    <LinkPullRequestDialog
      open
      threadRef={threadRef}
      projectId={thread?.projectId ?? null}
      issuesSupported={issuesSupported}
      onOpenChange={(open) => {
        if (!open) appAtomRegistry.set(linkPullRequestDialogThreadAtom, null);
      }}
    />
  );
}

interface ResolvedLink {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
}

/**
 * Which pull request an input names, or why it cannot. A URL carries its own host and
 * repository; a bare `#123` can only mean the thread's own repository.
 */
export function resolveLinkPullRequestInput(input: {
  readonly reference: string;
  readonly project: {
    readonly host: string;
    readonly repository: string;
    readonly webUrl: (number: number) => string | null;
  } | null;
  readonly hasProject: (reference: ResolvedLink) => boolean;
}): { link: ResolvedLink } | { error: string } | null {
  const parsed =
    parseChangeRequestUrl(input.reference.trim()) !== null
      ? input.reference.trim()
      : parsePullRequestReference(input.reference);
  if (parsed === null) return null;
  const url = parseChangeRequestUrl(parsed);
  if (url !== null) {
    if (!input.hasProject({ ...url, url: parsed })) {
      return { error: `No project in this environment can read ${url.host}/${url.repository}.` };
    }
    return {
      link: { host: url.host, repository: url.repository, number: url.number, url: parsed },
    };
  }
  const number = Number(parsed);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  if (input.project === null) {
    return { error: "Paste a full URL to link a pull request from another repository." };
  }
  const webUrl = input.project.webUrl(number);
  const webReference = webUrl === null ? null : parseChangeRequestUrl(webUrl);
  if (webUrl === null || webReference === null) {
    return { error: "Paste a full URL; this project's host has no known pull request URL." };
  }
  return {
    link: { ...webReference, url: webUrl },
  };
}

export function linkPullRequestPreviewTarget(input: {
  readonly environmentId: EnvironmentId;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly pullRequestsEnabled: boolean;
  readonly anyRepositoryOnHost: boolean;
  readonly url: string;
}) {
  const exact = resolvePullRequestPreviewTarget(input);
  const parsed = parseChangeRequestUrl(input.url);
  if (exact !== null || !input.pullRequestsEnabled || !input.anyRepositoryOnHost || !parsed) {
    return exact;
  }
  const project = findProjectOnChangeRequestHost(input.projects, parsed);
  return project === undefined
    ? null
    : {
        environmentId: input.environmentId,
        input: {
          projectId: project.id,
          host: parsed.authority ?? parsed.host,
          repository: parsed.repository,
          number: parsed.number,
        },
      };
}

type LinkKind = "issue" | "pull-request";

const ISSUE_URL_PATHS = [
  /^\/((?:[\w.-]+\/)+[\w.-]+)\/-\/(?:issues|work_items)\/([1-9]\d{0,8})\/?$/u,
  /^\/([\w.-]+\/[\w.-]+)\/issues\/([1-9]\d{0,8})\/?$/u,
  /^\/([^/]+(?:\/[^/]+)?)\/_workitems\/edit\/([1-9]\d{0,8})\/?$/u,
];
const REPOSITORY_ISSUE = /^([\w.-]+(?:\/[\w.-]+)+)#([1-9]\d{0,8})$/u;
const LINEAR_ISSUE_PATH = /^\/[^/]+\/issue\/([A-Za-z0-9]+)-([1-9]\d{0,8})(?:\/|$)/u;

const linearIssueMatch = (url: URL) =>
  url.hostname.toLowerCase() === "linear.app" ? LINEAR_ISSUE_PATH.exec(url.pathname) : null;

const issueUrlMatch = (url: URL) => {
  if (/^\/groups\/.+\/-\/(?:issues|work_items)\//u.test(url.pathname)) return null;
  if (url.hostname === "bitbucket.org") {
    return /^\/([\w.-]+\/[\w.-]+)\/issues\/([1-9]\d{0,8})(?:\/[^/]+)?\/?$/u.exec(url.pathname);
  }
  return (
    ISSUE_URL_PATHS.map((path) => path.exec(url.pathname)).find((match) => match !== null) ?? null
  );
};

const selectLinearBindings = (settings: UnifiedSettings) =>
  settings.issueTracking.connections.linear?.projectBindings;

export function linkReferenceKind(reference: string, chosen: LinkKind): LinkKind {
  const trimmed = reference.trim();
  if (/^#?\d+$/u.test(trimmed)) return chosen;
  if (REPOSITORY_ISSUE.test(trimmed)) return "issue";
  if (!URL.canParse(trimmed)) return "pull-request";
  const url = new URL(trimmed);
  return /^https?:$/u.test(url.protocol) &&
    (issueUrlMatch(url) !== null || linearIssueMatch(url) !== null)
    ? "issue"
    : "pull-request";
}

interface IssueProject {
  readonly id: ProjectId;
  readonly repository: string;
}

export function linkIssuePreviewMatchesReference(
  reference: string,
  issue: { readonly provider: string; readonly url: string },
): boolean {
  if (parseChangeRequestUrl(issue.url) !== null) return false;
  if (issue.provider !== "linear" || !URL.canParse(reference)) return true;
  const requested = new URL(reference);
  const preview = new URL(issue.url);
  return (
    requested.hostname === preview.hostname &&
    requested.pathname.split("/").slice(0, 4).join("/").toLowerCase() ===
      preview.pathname.split("/").slice(0, 4).join("/").toLowerCase()
  );
}

export function linearProjectForTeam(input: {
  readonly team: string;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId }>;
  readonly currentProjectId: string | null;
  readonly bindings:
    | Readonly<Record<ProjectId, { readonly repository: string } | null>>
    | undefined;
}): ProjectId | undefined {
  const bound = input.projects.filter(
    (project) =>
      input.bindings?.[project.id]?.repository.toLowerCase() === input.team.toLowerCase(),
  );
  return (
    bound.find((project) => project.id === input.currentProjectId) ??
    bound[0] ??
    input.projects.find((project) => project.id === input.currentProjectId)
  )?.id;
}

export function resolveLinkIssueInput(input: {
  readonly reference: string;
  readonly project: (IssueProject & { readonly host: string }) | null;
  readonly findProject: (link: {
    readonly host: string;
    readonly repository: string;
  }) => IssueProject | undefined;
  readonly linearProjectId: (team: string) => ProjectId | undefined;
}): { issue: IssueRef } | { error: string } | null {
  const trimmed = input.reference.trim();
  const bare = /^#?(\d+)$/u.exec(trimmed);
  if (bare?.[1]) {
    const number = Number(bare[1]);
    if (!Number.isSafeInteger(number) || number < 1) return null;
    if (input.project === null) {
      return { error: "Paste a full URL to link an issue from another repository." };
    }
    return {
      issue: { projectId: input.project.id, repository: input.project.repository, number },
    };
  }
  const url = URL.canParse(trimmed) ? new URL(trimmed) : null;
  if (url !== null && !/^https?:$/u.test(url.protocol)) return null;
  const linear = url === null ? null : linearIssueMatch(url);
  if (linear?.[1] && linear[2]) {
    const projectId = input.linearProjectId(linear[1]);
    if (projectId === undefined) {
      return { error: `No project in this environment can read Linear team ${linear[1]}.` };
    }
    return {
      issue: {
        projectId,
        provider: "linear",
        host: "linear.app",
        repository: linear[1],
        number: Number(linear[2]),
      },
    };
  }
  const match = url === null ? REPOSITORY_ISSUE.exec(trimmed) : issueUrlMatch(url);
  if (!match?.[1] || !match[2]) return null;
  const host = url?.hostname ?? input.project?.host;
  if (host === undefined) {
    return { error: "Paste a full URL to link an issue from another repository." };
  }
  const project = input.findProject({ host, repository: match[1] });
  if (project === undefined) {
    return { error: `No project in this environment can read ${host}/${match[1]}.` };
  }
  return {
    issue: { projectId: project.id, repository: project.repository, number: Number(match[2]) },
  };
}

function LinkPullRequestDialog({
  open,
  threadRef,
  projectId,
  issuesSupported,
  onOpenChange,
}: LinkPullRequestDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [reference, setReference] = useState("");
  const [chosenKind, setChosenKind] = useState<LinkKind>("pull-request");
  const [dirty, setDirty] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const projects = useProjects();
  const environmentProjects = useMemo(
    () => projects.filter((project) => project.environmentId === threadRef.environmentId),
    [projects, threadRef.environmentId],
  );
  const ownProject = useMemo(() => {
    const project = environmentProjects.find((candidate) => candidate.id === projectId);
    const identity = project?.repositoryIdentity;
    if (!project || !identity) return null;
    const repository =
      identity.displayName ??
      (identity.owner && identity.name ? `${identity.owner}/${identity.name}` : null);
    if (repository === null) return null;
    const kind = identity.provider as SourceControlProviderKind;
    const host = pullRequestHostOf(identity, kind);
    return {
      id: project.id,
      host,
      repository,
      webUrl: (number: number) =>
        kind === "forgejo" && identity.webUrl
          ? `${identity.webUrl.replace(/\/+$/, "")}/pulls/${number}`
          : changeRequestWebUrl(kind, host, repository, number, identity.locator.remoteUrl),
    };
  }, [environmentProjects, projectId]);
  const linking = usePullRequestLinking(threadRef.environmentId);
  const thread = useThreadShell(threadRef);
  const configs = useServerConfigs();
  const linearBindings = useEnvironmentSettings(threadRef.environmentId, selectLinearBindings);
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const settledReference = useDebouncedValue(reference, 250);
  const settled = settledReference === reference;
  const pullRequestsSupported = linking.mode !== "unsupported";
  const bare = /^#?\d+$/u.test(reference.trim());
  const kind = !issuesSupported
    ? "pull-request"
    : !pullRequestsSupported
      ? "issue"
      : linkReferenceKind(reference, chosenKind);

  useEffect(() => {
    if (!open) return;
    setReference("");
    setDirty(false);
    setSubmitError(null);
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const resolvedPullRequest = useMemo(
    () =>
      kind === "pull-request"
        ? resolveLinkPullRequestInput({
            reference,
            project: ownProject,
            hasProject: (reference) => linking.canLink(reference.url),
          })
        : null,
    [kind, linking, ownProject, reference],
  );
  const resolvedIssue = useMemo(
    () =>
      kind === "issue"
        ? resolveLinkIssueInput({
            reference,
            project: ownProject,
            findProject: (link) => {
              const project = findProjectForIssue(environmentProjects, link);
              return project === undefined
                ? undefined
                : {
                    id: project.id,
                    repository: repositoryForProjectLink(project, link.repository),
                  };
            },
            linearProjectId: (team) =>
              linearProjectForTeam({
                team,
                projects: environmentProjects,
                currentProjectId: projectId,
                bindings: linearBindings,
              }),
          })
        : null,
    [environmentProjects, kind, linearBindings, ownProject, projectId, reference],
  );
  const resolved = kind === "issue" ? resolvedIssue : resolvedPullRequest;

  const pullRequestPreviewTarget =
    resolvedPullRequest !== null && "link" in resolvedPullRequest
      ? linkPullRequestPreviewTarget({
          environmentId: threadRef.environmentId,
          projects: environmentProjects,
          pullRequestsEnabled:
            configs.get(threadRef.environmentId)?.environment.capabilities.pullRequests === true,
          anyRepositoryOnHost: linking.mode === "multiple",
          url: resolvedPullRequest.link.url,
        })
      : null;
  const pullRequestPreview = useEnvironmentQuery(
    settled && pullRequestPreviewTarget !== null
      ? pullRequestEnvironment.detail(pullRequestPreviewTarget)
      : null,
  );
  const issuePreview = useEnvironmentQuery(
    settled && resolvedIssue !== null && "issue" in resolvedIssue
      ? issueEnvironment.detail({
          environmentId: threadRef.environmentId,
          input: resolvedIssue.issue,
        })
      : null,
  );
  const previewIssue = settled ? issuePreview.data : null;
  const issueReferenceMismatch =
    previewIssue != null && !linkIssuePreviewMatchesReference(reference, previewIssue);
  const issue = issueReferenceMismatch ? null : previewIssue;
  const pullRequest = settled && pullRequestPreviewTarget !== null ? pullRequestPreview.data : null;
  const preview =
    kind === "issue"
      ? issue && {
          state: issue.state === "open" ? "Open" : "Closed",
          title: issue.title,
          author: issue.author?.login,
        }
      : pullRequest && {
          state:
            PULL_REQUEST_STATE_PRESENTATION[
              pullRequest.state === "open" && pullRequest.isDraft ? "draft" : pullRequest.state
            ].label,
          title: pullRequest.title,
          author: pullRequest.author?.login,
        };
  const previewQuery = kind === "issue" ? issuePreview : pullRequestPreview;
  const duplicate =
    kind === "issue"
      ? issue != null &&
        (thread?.issues ?? []).some(
          (link) =>
            link.provider === issue.provider &&
            link.repository.toLowerCase() === issue.repository.toLowerCase() &&
            link.number === issue.number &&
            normalizeWorkItemLinkKey(link).url === normalizeWorkItemLinkKey(issue).url,
        )
      : resolvedPullRequest !== null &&
        "link" in resolvedPullRequest &&
        linking.isLinked(thread, resolvedPullRequest.link.url);
  const canSubmit =
    !pending &&
    resolved !== null &&
    !("error" in resolved) &&
    !duplicate &&
    (kind === "issue"
      ? issuePreview.isSuccess && issue != null
      : pullRequestPreviewTarget === null || (pullRequestPreview.isSuccess && pullRequest != null));

  const submit = useCallback(async () => {
    setDirty(true);
    if (!canSubmit) return;
    setSubmitError(null);
    setPending(true);
    try {
      if (issue != null) {
        const result = await updateMetadata({
          environmentId: threadRef.environmentId,
          input: {
            threadId: threadRef.threadId,
            issueLink: {
              projectId: issue.projectId,
              provider: issue.provider,
              repository: issue.repository,
              number: issue.number,
              url: issue.url,
              title: issue.title,
            },
          },
        });
        if (result._tag === "Failure") {
          if (isAtomCommandInterrupted(result)) throw new Error("Link update interrupted.");
          throw squashAtomCommandFailure(result);
        }
      } else if (resolvedPullRequest !== null && "link" in resolvedPullRequest) {
        await linking.changeLink(threadRef, resolvedPullRequest.link.url, true);
      }
    } catch (error) {
      setSubmitError(
        error instanceof Error
          ? error.message
          : `Could not link the ${kind === "issue" ? "issue" : "pull request"}.`,
      );
      return;
    } finally {
      setPending(false);
    }
    onOpenChange(false);
  }, [
    canSubmit,
    issue,
    kind,
    linking,
    onOpenChange,
    resolvedPullRequest,
    threadRef,
    updateMetadata,
  ]);

  const subject =
    issuesSupported && pullRequestsSupported
      ? "issue or pull request"
      : issuesSupported
        ? "issue"
        : "pull request";
  const noun = `${issuesSupported ? "an" : "a"} ${subject}`;
  const validation = duplicate
    ? `This ${kind === "issue" ? "issue" : "pull request"} is already linked to this thread.`
    : !dirty
      ? null
      : reference.trim().length === 0
        ? `Paste ${noun} URL or enter 123 / #123.`
        : resolved === null
          ? `Use ${noun} URL, 123, or #123.`
          : "error" in resolved
            ? resolved.error
            : null;

  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Link {subject}</DialogTitle>
          <DialogDescription>
            Attach {noun} to this thread by its URL, or by its number for this thread's repository.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Input
            ref={inputRef}
            placeholder={`${subject[0]?.toUpperCase()}${subject.slice(1)} URL or #42`}
            value={reference}
            onChange={(event) => {
              setDirty(true);
              setReference(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              void submit();
            }}
          />
          {bare && issuesSupported && pullRequestsSupported ? (
            <ToggleGroup
              aria-label="Link kind"
              variant="segmented"
              value={[chosenKind]}
              onValueChange={(value) => {
                const next = value[0];
                if (next === "issue" || next === "pull-request") setChosenKind(next);
              }}
            >
              <Toggle value="pull-request">Pull request</Toggle>
              <Toggle value="issue">Issue</Toggle>
            </ToggleGroup>
          ) : null}
          {resolvedPullRequest !== null && "link" in resolvedPullRequest ? (
            <p className="truncate text-muted-foreground text-xs">
              {resolvedPullRequest.link.host}/{resolvedPullRequest.link.repository} #
              {resolvedPullRequest.link.number}
            </p>
          ) : resolvedIssue !== null && "issue" in resolvedIssue ? (
            <p className="truncate text-muted-foreground text-xs">
              {resolvedIssue.issue.repository} #{resolvedIssue.issue.number}
            </p>
          ) : null}
          {preview ? (
            <p className="truncate text-xs">
              <span className="text-muted-foreground">{preview.state} · </span>
              {preview.title}
              {preview.author ? (
                <span className="text-muted-foreground"> · {preview.author}</span>
              ) : null}
            </p>
          ) : issueReferenceMismatch ? (
            <p className="text-destructive text-xs">
              {previewIssue.provider === "linear"
                ? "This project is connected to a different Linear workspace. Check its Linear account."
                : `${previewIssue.repository} #${previewIssue.number} is a pull request, not an issue.`}
            </p>
          ) : previewQuery.error !== null ? (
            <p className="text-destructive text-xs">{previewQuery.error}</p>
          ) : previewQuery.isPending ||
            (!settled &&
              (kind === "issue"
                ? resolvedIssue !== null && "issue" in resolvedIssue
                : pullRequestPreviewTarget !== null)) ? (
            <p className="text-muted-foreground text-xs">Loading preview…</p>
          ) : null}
          {(validation ?? submitError) ? (
            <p className="text-destructive text-xs">{validation ?? submitError}</p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={() => void submit()} disabled={!canSubmit}>
            {pending ? "Linking..." : "Link"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
