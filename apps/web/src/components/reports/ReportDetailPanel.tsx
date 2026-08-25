/**
 * Raw view of one PostHog report plus the "Implement" action that turns it
 * into a worktree thread whose first message is the rendered report.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  PostHogActionabilityAssessment,
  PostHogCodeReference,
  PostHogPriorityAssessment,
  PostHogRepoSelection,
  PostHogSignalFinding,
  PostHogSuggestedReviewers,
  postHogReportUrl,
  type EnvironmentId,
  type PostHogReport,
  type PostHogReportArtefact,
  type ProviderDriverKind,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { renderReportPrompt } from "@t3tools/shared/posthogReportPrompt";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useMemo, useState } from "react";

import { buildThreadRouteParams } from "../../threadRoutes";
import { newThreadId, randomUUID } from "../../lib/utils";
import { useProjects, useThreadShells } from "../../state/entities";
import { postHogEnvironment } from "../../state/posthog";
import { primaryServerSettingsAtom } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { ReportOpenActions } from "./ReportOpenActions";
import { usePostHogQuery } from "./reportsQuery";

const decodeFinding = Schema.decodeUnknownOption(PostHogSignalFinding);
const decodePriority = Schema.decodeUnknownOption(PostHogPriorityAssessment);
const decodeActionability = Schema.decodeUnknownOption(PostHogActionabilityAssessment);
const decodeCodeReference = Schema.decodeUnknownOption(PostHogCodeReference);
const decodeReviewers = Schema.decodeUnknownOption(PostHogSuggestedReviewers);
const decodeRepoSelection = Schema.decodeUnknownOption(PostHogRepoSelection);

function decodeAll<A>(
  artefacts: ReadonlyArray<PostHogReportArtefact>,
  type: string,
  decode: (content: unknown) => Option.Option<A>,
): ReadonlyArray<{ readonly id: string; readonly value: A }> {
  return artefacts
    .filter((artefact) => artefact.type === type)
    .flatMap((artefact) =>
      Option.toArray(decode(artefact.content)).map((value) => ({ id: artefact.id, value })),
    );
}

function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

const reportBranchName = (reportId: string): string => `posthog/${reportId.slice(0, 8)}`;

export function ReportDetailPanel({
  environmentId,
  report,
}: {
  readonly environmentId: EnvironmentId;
  readonly report: PostHogReport;
}) {
  const navigate = useNavigate();
  const artefactsQuery = usePostHogQuery(
    postHogEnvironment.artefacts({ environmentId, input: { reportId: report.id } }),
  );
  const artefacts = artefactsQuery.data?.artefacts ?? [];
  const serverSettings = useAtomValue(primaryServerSettingsAtom);
  const projects = useProjects();
  const environmentProjects = useMemo(
    () => projects.filter((project) => project.environmentId === environmentId),
    [environmentId, projects],
  );
  const threadShells = useThreadShells();
  const linkedThreads = useMemo(
    () => threadShells.filter((shell) => shell.reportId === report.id),
    [report.id, threadShells],
  );

  const findings = decodeAll(artefacts, "signal_finding", decodeFinding);
  const priority = decodeAll(artefacts, "priority_judgment", decodePriority)[0]?.value ?? null;
  const actionability =
    decodeAll(artefacts, "actionability_judgment", decodeActionability)[0]?.value ?? null;
  const codeReferences = decodeAll(artefacts, "code_reference", decodeCodeReference);
  const reviewers = decodeAll(artefacts, "suggested_reviewers", decodeReviewers)[0]?.value ?? [];
  const repoSelection =
    decodeAll(artefacts, "repo_selection", decodeRepoSelection)[0]?.value ?? null;

  // Preselect the only project, or the one whose remote matches the report's repo selection.
  const matchedProjectId = useMemo(() => {
    if (environmentProjects.length === 1) return environmentProjects[0]!.id;
    const repository = repoSelection?.repository?.toLowerCase() ?? null;
    if (!repository) return null;
    const match = environmentProjects.find((project) => {
      const identity = project.repositoryIdentity;
      return (
        identity?.owner !== undefined &&
        identity.name !== undefined &&
        `${identity.owner}/${identity.name}`.toLowerCase() === repository
      );
    });
    return match?.id ?? null;
  }, [environmentProjects, repoSelection]);
  const [chosenProjectId, setChosenProjectId] = useState<string | null>(null);
  const selectedProjectId = chosenProjectId ?? matchedProjectId;
  const selectedProject =
    environmentProjects.find((project) => project.id === selectedProjectId) ?? null;

  const refsQuery = useEnvironmentQuery(
    selectedProject === null
      ? null
      : vcsEnvironment.listRefs({
          environmentId,
          input: { cwd: selectedProject.workspaceRoot, includeMatchingRemoteRefs: true, limit: 2 },
        }),
  );
  const defaultBranch =
    refsQuery.data?.refs.find((ref) => ref.isDefault)?.name ??
    refsQuery.data?.refs.find((ref) => ref.current)?.name ??
    null;

  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [implementing, setImplementing] = useState(false);
  const [implementError, setImplementError] = useState<string | null>(null);

  const implement = async () => {
    if (!selectedProject || !defaultBranch || implementing) return;
    setImplementing(true);
    setImplementError(null);
    const threadId = newThreadId();
    const createdAt = new Date().toISOString();
    const instanceId =
      selectedProject.defaultModelSelection?.instanceId ??
      serverSettings.textGenerationModelSelection.instanceId;
    // Legacy instance ids equal their driver kind; explicit instances name it.
    const driverKind =
      serverSettings.providerInstances[instanceId]?.driver ??
      (instanceId as string as ProviderDriverKind);
    const modelSelection =
      selectedProject.defaultModelSelection ??
      createModelSelection(instanceId, DEFAULT_MODEL_BY_PROVIDER[driverKind] ?? DEFAULT_MODEL);
    const text = renderReportPrompt(report, artefacts, {
      host: serverSettings.posthog.host,
      projectId: serverSettings.posthog.projectId,
    });
    const result = await startThreadTurn({
      environmentId,
      input: {
        threadId,
        message: {
          messageId: MessageId.make(randomUUID()),
          role: "user",
          text,
          attachments: [],
        },
        modelSelection,
        titleSeed: report.title,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        bootstrap: {
          createThread: {
            projectId: selectedProject.id,
            title: report.title,
            modelSelection,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: defaultBranch,
            worktreePath: null,
            reportId: report.id,
            createdAt,
          },
          prepareWorktree: {
            projectCwd: selectedProject.workspaceRoot,
            baseBranch: defaultBranch,
            branch: reportBranchName(report.id),
            startFromOrigin: false,
          },
          runSetupScript: true,
        },
        createdAt,
      },
    });
    setImplementing(false);
    if (result._tag === "Failure") {
      setImplementError(String(result.cause));
      return;
    }
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });
  };

  const reportUrl = postHogReportUrl({
    host: serverSettings.posthog.host,
    projectId: serverSettings.posthog.projectId,
    reportId: report.id,
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5 text-sm">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold">{report.title}</h2>
        <p className="text-xs text-muted-foreground">
          {report.status}
          {report.priority ? ` · ${report.priority}` : ""}
          {report.actionability ? ` · ${report.actionability}` : ""}
          {" · "}
          <a className="underline" href={reportUrl} target="_blank" rel="noreferrer">
            Open in PostHog
          </a>
        </p>
      </header>

      <Section title="Implement">
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="h-8 rounded-md border border-border bg-background px-2 text-sm"
            value={selectedProjectId ?? ""}
            onChange={(event) => setChosenProjectId(event.target.value || null)}
          >
            <option value="">Select a project</option>
            {environmentProjects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.title}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            disabled={
              !selectedProject || !defaultBranch || implementing || artefactsQuery.isPending
            }
            onClick={() => void implement()}
          >
            {implementing ? "Starting…" : "Implement"}
          </Button>
          {selectedProject ? (
            <span className="text-xs text-muted-foreground">
              {defaultBranch
                ? `Worktree ${reportBranchName(report.id)} from ${defaultBranch}`
                : "Resolving default branch…"}
            </span>
          ) : null}
        </div>
        {implementError ? <p className="text-xs text-destructive">{implementError}</p> : null}
        <ReportOpenActions
          environmentId={environmentId}
          report={report}
          artefacts={artefacts}
          project={selectedProject}
          defaultBranch={defaultBranch}
          branchName={reportBranchName(report.id)}
        />
        {linkedThreads.length > 0 ? (
          <ul className="space-y-1">
            {linkedThreads.map((thread) => (
              <li key={thread.id}>
                <button
                  type="button"
                  className="text-left underline"
                  onClick={() =>
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: buildThreadRouteParams(
                        scopeThreadRef(thread.environmentId, thread.id),
                      ),
                    })
                  }
                >
                  {thread.title}
                </button>
                <span className="text-xs text-muted-foreground">
                  {thread.branch ? ` · ${thread.branch}` : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      {report.summary ? (
        <Section title="Summary">
          <p className="whitespace-pre-wrap">{report.summary}</p>
        </Section>
      ) : null}

      {artefactsQuery.error ? (
        <p className="text-xs text-destructive">{artefactsQuery.error.message}</p>
      ) : null}
      {artefactsQuery.isPending && artefacts.length === 0 ? (
        <p className="text-xs text-muted-foreground">Loading artefacts…</p>
      ) : null}

      {priority ? (
        <Section title="Priority">
          <p>
            <strong>{priority.priority}</strong>
            {priority.dollar_value !== undefined && priority.dollar_value !== null
              ? ` · $${Math.round(priority.dollar_value).toLocaleString("en-US")}`
              : ""}
          </p>
          {priority.explanation ? (
            <p className="whitespace-pre-wrap text-muted-foreground">{priority.explanation}</p>
          ) : null}
        </Section>
      ) : null}

      {actionability ? (
        <Section title="Actionability">
          <p>
            <strong>{actionability.actionability}</strong>
            {actionability.already_addressed ? " · already addressed" : ""}
          </p>
          {actionability.explanation ? (
            <p className="whitespace-pre-wrap text-muted-foreground">{actionability.explanation}</p>
          ) : null}
        </Section>
      ) : null}

      {findings.length > 0 ? (
        <Section title="Findings">
          <ul className="space-y-3">
            {findings.map(({ id, value: finding }) => (
              <li key={id} className="space-y-1">
                <p>
                  <strong>{finding.signal_id}</strong>
                  {finding.verified ? " · verified" : ""}
                </p>
                {finding.relevant_code_paths.length > 0 ? (
                  <ul className="list-disc pl-5 font-mono text-xs">
                    {finding.relevant_code_paths.map((codePath) => (
                      <li key={codePath}>{codePath}</li>
                    ))}
                  </ul>
                ) : null}
                {Object.keys(finding.relevant_commit_hashes).length > 0 ? (
                  <ul className="list-disc pl-5 text-xs">
                    {Object.entries(finding.relevant_commit_hashes).map(([hash, note]) => (
                      <li key={hash}>
                        <span className="font-mono">{hash}</span>: {note}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {finding.data_queried ? (
                  <p className="text-xs text-muted-foreground">Data: {finding.data_queried}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {codeReferences.length > 0 ? (
        <Section title="Code references">
          <ul className="space-y-3">
            {codeReferences.map(({ id, value: reference }) => (
              <li key={id} className="space-y-1">
                <p className="font-mono text-xs">
                  {reference.file_path}:{reference.start_line}-{reference.end_line}
                </p>
                {reference.relevance_note ? (
                  <p className="text-muted-foreground">{reference.relevance_note}</p>
                ) : null}
                <pre className="overflow-x-auto rounded-md bg-muted p-2 text-xs">
                  {reference.contents}
                </pre>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {reviewers.length > 0 ? (
        <Section title="Suggested reviewers">
          <ul className="list-disc pl-5">
            {reviewers.map((reviewer) => (
              <li key={reviewer.github_login}>
                @{reviewer.github_login}
                {reviewer.github_name ? ` (${reviewer.github_name})` : ""}
                {reviewer.reason ? ` · ${reviewer.reason}` : ""}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {repoSelection ? (
        <Section title="Repository">
          <p className="font-mono text-xs">{repoSelection.repository ?? "none"}</p>
          {repoSelection.reason ? (
            <p className="text-muted-foreground">{repoSelection.reason}</p>
          ) : null}
        </Section>
      ) : null}
    </div>
  );
}
