import { useEnvironmentScope } from "~/state/session";
import { readLocalApi } from "~/localApi";
import { useAtomCommand } from "~/state/use-atom-command";
import { ChecksBody } from "../components/pullRequest/PullRequestChecksPopover";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  AuthSourceControlWriteScope,
  type ProjectMergeQueue,
  type ProjectMergeQueuesResult,
  type EnvironmentId,
} from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { GitBranchIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { formatFullTimestamp, formatShortTimestamp } from "../timestampFormat";
import { useClientSettings } from "../hooks/useSettings";
import { useEnvironments } from "../state/environments";
import { pullRequestEnvironment } from "../state/pullRequests";
import { useEnvironmentQuery } from "../state/query";
import { MERGE_QUEUE_STATE_LABELS } from "../components/pullRequest/pullRequestDetail.logic";
import { Button } from "../components/ui/button";

export const Route = createFileRoute("/_chat/merge-queues")({ component: MergeQueuesPage });

function QueueRow({
  entry,
  project,
  environmentId,
  refresh,
}: {
  entry: ProjectMergeQueue["entries"][number];
  project: ProjectMergeQueuesResult[number];
  environmentId: EnvironmentId;
  refresh: () => void;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canWrite = useEnvironmentScope(environmentId, AuthSourceControlWriteScope);
  const act = useAtomCommand(pullRequestEnvironment.runAction, { reportFailure: false });
  const remove = async () => {
    if (
      !(await readLocalApi()?.dialogs.confirm(
        gt("Remove {repository} #{number} from the merge queue?", {
          repository: project.repository,
          number: entry.number,
        }),
        { variant: "destructive" },
      ))
    )
      return;
    setError(null);
    const result = await act({
      environmentId,
      input: {
        projectId: project.projectId,
        repository: project.repository,
        host: project.host,
        number: entry.number,
        action: "disable-auto-merge",
      },
    });
    if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
    refresh();
  };
  return (
    <li className="border-t px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className="flex flex-1 items-center gap-3 text-left hover:text-primary"
        >
          <span
            className="font-mono tabular-nums"
            aria-label={gt("Queue position {position}", { position: entry.position })}
          >
            {entry.position}
          </span>
          <span>
            <span className="mr-2 text-muted-foreground">#{entry.number}</span>
            {entry.title}
          </span>
        </button>
        <span className="text-sm text-muted-foreground">
          {resolve(MERGE_QUEUE_STATE_LABELS[entry.state])}
        </span>
        {canWrite && (
          <Button
            size="xs"
            variant="outline"
            disabled={pending}
            onClick={() => {
              setPending(true);
              void remove()
                .catch((cause: unknown) => setError(String(cause)))
                .finally(() => setPending(false));
            }}
          >
            <T>Remove from queue</T>
          </Button>
        )}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        {entry.enqueuedAt &&
          gt("Enqueued {time}", {
            time: formatFullTimestamp(entry.enqueuedAt, timestampFormat),
          })}{" "}
        ·{" "}
        {entry.estimatedMergeAt
          ? gt("Estimated merge {time}", {
              time: formatShortTimestamp(entry.estimatedMergeAt, timestampFormat),
            })
          : gt("Merge estimate unavailable")}
      </div>
      {error && <p role="alert">{error}</p>}
      {expanded && (
        <div className="mt-3 space-y-2 rounded-md border p-3">
          <h4 className="text-sm font-medium">
            <T>Merge group checks</T>
          </h4>
          {entry.checks ? (
            <ChecksBody showRequired checks={entry.checks} threadRef={null} />
          ) : (
            <p>
              <T>Merge group checks unavailable</T>
            </p>
          )}
          <Link
            to="/pull-requests"
            search={{
              state: "open",
              involvement: "all",
              repository: project.repository,
              number: entry.number,
              selectedHost: project.host,
              selectedProjectId: project.projectId,
              selectedEnvironmentId: environmentId,
            }}
            className="text-xs text-primary hover:underline"
          >
            <T>Open pull request</T>
          </Link>
        </div>
      )}
    </li>
  );
}

function EnvironmentQueues({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string;
}) {
  const gt = useGT();
  const query = useEnvironmentQuery(
    pullRequestEnvironment.mergeQueues({ environmentId, input: {} }),
  );
  const { refresh, isPending } = query;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Refresh the mounted overview while the window is visible.
  useEffect(() => {
    if (isPending) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) refresh();
    }, 60000);
    return () => window.clearInterval(timer);
  }, [refresh, isPending]);
  const projects = query.data?.filter((p) => p.queues === null || p.queues.length > 0);
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between border-b pb-2">
        <h2 className="font-medium">{label}</h2>
        <Button
          size="xs"
          variant="outline"
          disabled={isPending}
          onClick={refresh}
          aria-label={gt("Refresh")}
        >
          <RefreshCwIcon className="size-3.5" />
          <T>Refresh</T>
        </Button>
      </div>
      {query.error ? (
        <p role="alert">{query.error}</p>
      ) : projects === undefined ? (
        <p className="text-muted-foreground">
          <T>Loading merge queues…</T>
        </p>
      ) : projects.length === 0 ? (
        <p className="text-muted-foreground">
          <T>No merge queues found for these projects.</T>
        </p>
      ) : (
        projects.map((project) => (
          <div key={project.projectId} className="rounded-lg border">
            <div className="px-4 py-3 font-medium">{project.repository}</div>
            {project.queues === null ? (
              <p className="border-t px-4 py-3 text-muted-foreground">
                <T>Could not read this repository’s merge queues.</T>
              </p>
            ) : (
              project.queues.map((queue) => (
                <section key={queue.branch}>
                  <h3 className="flex items-center gap-2 border-t bg-muted/40 px-4 py-2 font-mono text-sm">
                    <GitBranchIcon className="size-3.5" />
                    {queue.branch}
                  </h3>
                  {queue.entries.length === 0 ? (
                    <p className="px-4 py-3 text-muted-foreground">
                      <T>Queue is empty</T>
                    </p>
                  ) : (
                    <ol>
                      {queue.entries.map((entry) => (
                        <QueueRow
                          key={entry.number}
                          entry={entry}
                          project={project}
                          environmentId={environmentId}
                          refresh={refresh}
                        />
                      ))}
                    </ol>
                  )}
                </section>
              ))
            )}
          </div>
        ))
      )}
    </section>
  );
}

function MergeQueuesPage() {
  const enabled = useClientSettings((s) => s.mergeQueuesEnabled);
  const { environments } = useEnvironments();
  return (
    <main className="flex h-full min-h-0 flex-1 flex-col overflow-auto scrollbar-gutter-both">
      <header className="drag-region border-b px-5 py-3 font-medium">
        <T>Merge queues</T>
      </header>
      <div className="mx-auto w-full max-w-4xl space-y-6 p-5">
        {enabled ? (
          environments.length ? (
            environments.map((env) =>
              env.connection.phase === "connected" ? (
                <EnvironmentQueues
                  key={env.environmentId}
                  environmentId={env.environmentId}
                  label={env.label}
                />
              ) : (
                <p key={env.environmentId}>
                  {env.label} · <T>Disconnected</T>
                </p>
              ),
            )
          ) : (
            <p>
              <T>No connected environments</T>
            </p>
          )
        ) : (
          <Link to="/settings/diffs">
            <T>Enable merge queues in Settings</T>
          </Link>
        )}
      </div>
    </main>
  );
}
