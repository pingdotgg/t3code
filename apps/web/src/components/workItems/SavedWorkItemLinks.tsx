import type {
  EnvironmentId,
  IssueRef,
  ProjectId,
  PullRequestRef,
  WorkItemLink,
  WorkItemLinkInput,
  WorkItemLinkKey,
} from "@t3tools/contracts";
import { normalizeWorkItemLinkKey } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { LinkIcon, RefreshCwIcon, UnlinkIcon } from "lucide-react";
import { useState, type FormEvent } from "react";

import { openLinkInBrowser } from "~/lib/openIssueLink";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useProjects, useServerConfigs } from "~/state/entities";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { workItemLinks } from "~/state/workItems";

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

type Source =
  | {
      readonly kind: "issue";
      readonly reference: IssueRef;
      readonly provider: string;
      readonly url: string;
    }
  | {
      readonly kind: "pull-request";
      readonly reference: PullRequestRef;
      readonly provider: string;
      readonly url: string;
    };

function repositoryOf(project: EnvironmentProject | undefined): string {
  const identity = project?.repositoryIdentity;
  return (
    identity?.displayName ??
    (identity?.owner && identity.name ? `${identity.owner}/${identity.name}` : "")
  );
}

function linkTarget(
  kind: Source["kind"],
  projectId: ProjectId | null,
  provider: string,
  repository: string,
  numberText: string,
): {
  readonly projectId: ProjectId;
  readonly provider: string;
  readonly repository: string;
  readonly number: number;
} | null {
  const number = Number(numberText);
  const repo = repository.trim();
  if (projectId === null || repo.length === 0 || !Number.isSafeInteger(number) || number < 1)
    return null;
  if (kind === "pull-request" && provider.trim().length === 0) return null;
  return { projectId, provider: provider.trim(), repository: repo, number };
}

export function SavedWorkItemLinks({
  environmentId,
  source,
}: {
  environmentId: EnvironmentId;
  source: Source;
}) {
  const supported =
    useServerConfigs().get(environmentId)?.environment.capabilities.workItemLinks === true;
  if (!supported) return null;
  return (
    <EnabledSavedWorkItemLinks
      key={`${environmentId}:${source.reference.projectId}:${source.url}`}
      environmentId={environmentId}
      source={source}
    />
  );
}

function EnabledSavedWorkItemLinks({
  environmentId,
  source,
}: {
  environmentId: EnvironmentId;
  source: Source;
}) {
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const [projectId, setProjectId] = useState<ProjectId>(source.reference.projectId);
  const selectedProject = projects.find((project) => project.id === projectId) ?? null;
  const [repository, setRepository] = useState(() =>
    repositoryOf(projects.find((project) => project.id === source.reference.projectId)),
  );
  const [provider, setProvider] = useState(source.provider);
  const [number, setNumber] = useState("");
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sourceKey: WorkItemLinkKey = normalizeWorkItemLinkKey({
    provider: source.provider,
    url: source.url,
  });
  const query = useEnvironmentQuery(
    workItemLinks.list({ environmentId, input: { source: sourceKey } }),
  );
  const link = useAtomCommand(workItemLinks.link, { reportFailure: false });
  const unlink = useAtomCommand(workItemLinks.unlink, { reportFailure: false });
  const targetKind = source.kind === "issue" ? "pull request" : "issue";

  const refreshPair = (pair: WorkItemLink) => {
    for (const item of [pair.issue, pair.pullRequest]) {
      appAtomRegistry.refresh(
        workItemLinks.list({
          environmentId,
          input: { source: normalizeWorkItemLinkKey({ provider: item.provider, url: item.url }) },
        }),
      );
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const target = linkTarget(
      source.kind,
      selectedProject?.id ?? null,
      provider,
      repository,
      number,
    );
    if (target === null) {
      setError(
        `Choose a project and enter a repository, ${targetKind === "issue" ? "provider, " : ""}and positive number.`,
      );
      return;
    }
    setPending(true);
    setError(null);
    const input: WorkItemLinkInput =
      source.kind === "issue"
        ? {
            issue: source.reference,
            pullRequest: {
              projectId: target.projectId,
              repository: target.repository,
              number: target.number,
            },
          }
        : {
            issue: {
              projectId: target.projectId,
              provider: target.provider,
              repository: target.repository,
              number: target.number,
            },
            pullRequest: source.reference,
          };
    const result = await link({ environmentId, input });
    setPending(false);
    if (result._tag === "Failure") {
      setError(formatEnvironmentQueryError(result.cause));
      return;
    }
    refreshPair(result.value);
    setOpen(false);
    setNumber("");
  };

  const remove = async (pair: WorkItemLink) => {
    if (pending) return;
    setPending(true);
    setError(null);
    const result = await unlink({
      environmentId,
      input: {
        issue: { provider: pair.issue.provider, url: pair.issue.url },
        pullRequest: { provider: pair.pullRequest.provider, url: pair.pullRequest.url },
      },
    });
    setPending(false);
    if (result._tag === "Failure") {
      setError(formatEnvironmentQueryError(result.cause));
      return;
    }
    refreshPair(pair);
  };

  return (
    <div className="mt-3 border-t pt-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="mr-auto text-xs font-medium">Saved links in T3 Code</span>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Refresh saved links"
          disabled={pending}
          onClick={query.refresh}
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={pending}
          onClick={() => {
            setError(null);
            setOpen(true);
          }}
        >
          <LinkIcon className="size-3.5" /> Link {targetKind}
        </Button>
      </div>
      {query.isPending ? (
        <p className="text-xs text-muted-foreground">Loading saved links…</p>
      ) : null}
      {query.error ? (
        <p role="alert" className="text-xs text-destructive">
          {query.error}
        </p>
      ) : null}
      {error && !open ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {query.data?.links.map((pair) => {
        const target = source.kind === "issue" ? pair.pullRequest : pair.issue;
        return (
          <div
            key={`${pair.issue.provider}:${pair.issue.url}:${pair.pullRequest.provider}:${pair.pullRequest.url}`}
            className="flex items-center gap-1"
          >
            <button
              type="button"
              className="min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent/60"
              onClick={() => openLinkInBrowser(target.url)}
            >
              {target.title}{" "}
              <span className="text-muted-foreground">
                {target.repository}#{target.number}
              </span>
            </button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Unlink ${target.title}`}
              disabled={pending}
              onClick={() => void remove(pair)}
            >
              <UnlinkIcon className="size-3.5" />
            </Button>
          </div>
        );
      })}
      {query.data?.truncated ? (
        <p className="text-xs text-muted-foreground">More saved links exist.</p>
      ) : null}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!pending) setOpen(next);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Link {targetKind}</DialogTitle>
            <DialogDescription>
              This saves a link in T3 Code. It does not change the pull request description or close
              an issue.
            </DialogDescription>
          </DialogHeader>
          <form className="flex min-h-0 flex-col" onSubmit={(event) => void submit(event)}>
            <DialogPanel className="space-y-3">
              <label className="block text-xs">
                Project
                <select
                  className="mt-1 w-full rounded-md border bg-background p-2"
                  value={projectId}
                  disabled={pending}
                  onChange={(event) => {
                    const project = projects.find((entry) => entry.id === event.target.value);
                    if (project) {
                      setProjectId(project.id);
                      setRepository(repositoryOf(project));
                    }
                  }}
                >
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.title}
                    </option>
                  ))}
                </select>
              </label>
              {targetKind === "issue" ? (
                <label className="block text-xs">
                  Provider
                  <Input
                    className="mt-1"
                    value={provider}
                    disabled={pending}
                    onChange={(event) => setProvider(event.target.value)}
                    placeholder="github or linear"
                  />
                </label>
              ) : null}
              <label className="block text-xs">
                {targetKind === "issue" ? "Repository or Linear team" : "Repository"}
                <Input
                  className="mt-1"
                  value={repository}
                  disabled={pending}
                  onChange={(event) => setRepository(event.target.value)}
                  placeholder={targetKind === "issue" ? "owner/repo or TEAM" : "owner/repo"}
                />
              </label>
              <label className="block text-xs">
                Number
                <Input
                  className="mt-1"
                  type="number"
                  min={1}
                  step={1}
                  value={number}
                  disabled={pending}
                  onChange={(event) => setNumber(event.target.value)}
                />
              </label>
              {error ? (
                <p role="alert" className="text-xs text-destructive">
                  {error}
                </p>
              ) : null}
            </DialogPanel>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "Linking…" : `Link ${targetKind}`}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
