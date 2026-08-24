import type {
  GitHubIssueCliMissingError,
  GitHubIssueCliUnauthenticatedError,
  GitHubIssueDetail,
  GitHubIssueListEntry,
  GitHubIssueListInput,
  GitHubIssueListResult,
  GitHubIssueOperationError,
  GitHubIssueRef,
  OrchestrationProjectShell,
} from "@t3tools/contracts";
import {
  GitHubIssueCliMissingError as GitHubIssueCliMissingErrorClass,
  GitHubIssueCliUnauthenticatedError as GitHubIssueCliUnauthenticatedErrorClass,
  GitHubIssueOperationError as GitHubIssueOperationErrorClass,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import { decodeGitHubIssueDetail, decodeGitHubIssueList } from "./gitHubIssueJson.ts";

const DEFAULT_LIMIT = 50;
const PROJECT_CONCURRENCY = 8;
const ISSUE_LIST_FIELDS = "number,title,url,author,assignees,labels,state,createdAt,updatedAt";
const ISSUE_DETAIL_FIELDS = `${ISSUE_LIST_FIELDS},body,comments,closedAt`;

/** Every project reads through the one `gh`, so a CLI failure ends the whole request. */
type GitHubIssueCliError = GitHubIssueCliMissingError | GitHubIssueCliUnauthenticatedError;

type GitHubIssueError = GitHubIssueCliError | GitHubIssueOperationError;

interface GitHubProject {
  readonly project: OrchestrationProjectShell;
  readonly repository: string;
  readonly host: string;
}

export class GitHubIssueService extends Context.Service<
  GitHubIssueService,
  {
    readonly list: (
      input: GitHubIssueListInput,
    ) => Effect.Effect<GitHubIssueListResult, GitHubIssueError>;
    readonly detail: (input: GitHubIssueRef) => Effect.Effect<GitHubIssueDetail, GitHubIssueError>;
  }
>()("t3/githubIssue/GitHubIssueService") {}

function repositoryIdentityOf(project: OrchestrationProjectShell): string | null {
  const identity = project.repositoryIdentity;
  if (!identity) return null;
  if (identity.displayName) return identity.displayName;
  return identity.owner && identity.name ? `${identity.owner}/${identity.name}` : null;
}

function repositoryHostOf(project: OrchestrationProjectShell): string {
  return (
    project.repositoryIdentity?.canonicalKey?.split("/")[0]?.trim().toLowerCase() || "github.com"
  );
}

function cliRepository(project: GitHubProject): string {
  return project.host === "github.com"
    ? project.repository
    : `${project.host}/${project.repository}`;
}

function fromCliError(operation: string) {
  return (error: GitHubCli.GitHubCliError): GitHubIssueError => {
    if (error._tag === "GitHubCliUnavailableError") {
      return new GitHubIssueCliMissingErrorClass({ cause: error });
    }
    if (error._tag === "GitHubCliAuthenticationError") {
      return new GitHubIssueCliUnauthenticatedErrorClass({ cause: error });
    }
    return new GitHubIssueOperationErrorClass({ operation, detail: error.detail, cause: error });
  };
}

function decodeError(operation: string, cause: unknown): GitHubIssueOperationError {
  return new GitHubIssueOperationErrorClass({
    operation,
    detail: "GitHub CLI returned unreadable issue data.",
    cause,
  });
}

export const make = Effect.gen(function* () {
  const cli = yield* GitHubCli.GitHubCli;
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;

  const workspaceProjects = Effect.fn("GitHubIssueService.workspaceProjects")(function* (
    projectId?: GitHubIssueListInput["projectId"],
  ) {
    const snapshot = yield* projections.getShellSnapshot().pipe(
      Effect.mapError(
        (cause) =>
          new GitHubIssueOperationErrorClass({
            operation: "listProjects",
            detail: "The project list could not be read.",
            cause,
          }),
      ),
    );
    const seen = new Set<string>();
    const projects: GitHubProject[] = [];
    for (const project of snapshot.projects) {
      if (projectId !== undefined && project.id !== projectId) continue;
      if (project.repositoryIdentity?.provider !== "github") continue;
      const repository = repositoryIdentityOf(project);
      if (repository === null) continue;
      const host = repositoryHostOf(project);
      const key = `${host}/${repository}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      projects.push({ project, repository, host });
    }
    return projects;
  });

  const list: GitHubIssueService["Service"]["list"] = Effect.fn("GitHubIssueService.list")(
    function* (input) {
      const projects = yield* workspaceProjects(input.projectId);
      const limit = input.limit ?? DEFAULT_LIMIT;
      const batches = yield* Effect.forEach(
        projects,
        (project) =>
          cli
            .execute({
              cwd: project.project.workspaceRoot,
              args: [
                "issue",
                "list",
                "--repo",
                cliRepository(project),
                "--state",
                input.state,
                "--limit",
                String(limit + 1),
                "--json",
                ISSUE_LIST_FIELDS,
                ...(input.query === undefined ? [] : ["--search", input.query]),
              ],
            })
            .pipe(
              Effect.mapError(fromCliError("list")),
              Effect.flatMap((output) =>
                decodeGitHubIssueList(output.stdout).pipe(
                  Effect.mapError((cause) => decodeError("list", cause)),
                ),
              ),
              Effect.map((issues) => ({ project, issues })),
              Effect.match({
                onFailure: (error) => ({ project, error }),
                onSuccess: (value) => value,
              }),
            ),
        { concurrency: PROJECT_CONCURRENCY },
      );

      // A missing `gh` is the one failure no repository can survive, so it ends the request.
      const cliMissing = batches.find(
        (batch) => "error" in batch && batch.error._tag === "GitHubIssueCliMissingError",
      );
      if (cliMissing && "error" in cliMissing) return yield* cliMissing.error;

      // Authentication is per host: an unauthenticated Enterprise remote must not discard the
      // issues another repository answered with. Only a workspace that is entirely locked out
      // gets the global "run gh auth login" error, which is the only case where it is the answer.
      const unauthenticated = batches.filter(
        (batch) => "error" in batch && batch.error._tag === "GitHubIssueCliUnauthenticatedError",
      );
      if (unauthenticated.length > 0 && unauthenticated.length === batches.length) {
        const [first] = unauthenticated;
        if (first && "error" in first) return yield* first.error;
      }

      const entries: GitHubIssueListEntry[] = [];
      const errors: GitHubIssueListResult["errors"][number][] = [];
      let truncated = false;
      for (const batch of batches) {
        if ("error" in batch) {
          errors.push({
            projectId: batch.project.project.id,
            projectTitle: batch.project.project.title,
            // The failing host is named here because it is the one the reader has to sign in to.
            message:
              batch.error._tag === "GitHubIssueCliUnauthenticatedError"
                ? `${batch.project.repository} needs GitHub CLI authentication. Run \`gh auth login --hostname ${batch.project.host}\` and retry.`
                : `${batch.project.repository} could not be read.`,
          });
          continue;
        }
        truncated ||= batch.issues.length > limit;
        for (const issue of batch.issues.slice(0, limit)) {
          entries.push({
            ...issue,
            projectId: batch.project.project.id,
            projectTitle: batch.project.project.title,
            repository: batch.project.repository,
          });
        }
      }
      const sortedEntries = entries.toSorted((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      );
      truncated ||= sortedEntries.length > limit;
      return {
        entries: sortedEntries.slice(0, limit),
        errors,
        truncated,
      };
    },
  );

  const detail: GitHubIssueService["Service"]["detail"] = Effect.fn("GitHubIssueService.detail")(
    function* (input) {
      const projects = yield* workspaceProjects(input.projectId);
      const project = projects.find(
        (candidate) => candidate.repository.toLowerCase() === input.repository.toLowerCase(),
      );
      if (project === undefined) {
        return yield* new GitHubIssueOperationErrorClass({
          operation: "detail",
          detail: "This issue does not belong to the selected project.",
        });
      }
      const output = yield* cli
        .execute({
          cwd: project.project.workspaceRoot,
          args: [
            "issue",
            "view",
            String(input.number),
            "--repo",
            cliRepository(project),
            "--json",
            ISSUE_DETAIL_FIELDS,
          ],
        })
        .pipe(Effect.mapError(fromCliError("detail")));
      const issue = yield* decodeGitHubIssueDetail(output.stdout).pipe(
        Effect.mapError((cause) => decodeError("detail", cause)),
      );
      return {
        ...issue,
        projectId: project.project.id,
        projectTitle: project.project.title,
        workspaceRoot: project.project.workspaceRoot,
        repository: project.repository,
        commentCount: issue.comments.length,
      };
    },
  );

  return GitHubIssueService.of({ list, detail });
});

export const layer = Layer.effect(GitHubIssueService, make);
