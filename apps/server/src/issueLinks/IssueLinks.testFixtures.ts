import * as NodeServices from "@effect/platform-node/NodeServices";
import type { RepositoryIdentity } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ClosingReferences from "./closingReferences.ts";

/**
 * Closing references through the real `gh`. Suites without linked pull requests never call it;
 * the live suite reads real GitHub through it.
 */
export const closingReferencesLive = ClosingReferences.layer.pipe(
  Layer.provide(GitHubCli.layer),
  Layer.provide(VcsProcess.layer),
  Layer.provide(NodeServices.layer),
);

const CREATED_AT = "2026-09-01T00:00:00.000Z";

/** A GitHub identity the way the resolver reports one for a checkout of `owner/name`. */
function gitHubIdentity(repository: string): RepositoryIdentity {
  const [owner, name] = repository.split("/");
  return {
    canonicalKey: `github.com/${repository.toLowerCase()}`,
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: `git@github.com:${repository}.git`,
    },
    provider: "github",
    displayName: repository,
    ...(owner ? { owner } : {}),
    ...(name ? { name } : {}),
  };
}

/**
 * The real projection read side over whatever database is in context. Checkouts resolve to the
 * repository mapped for their workspace root instead of asking git.
 */
export const projectionLayer = (repositories: Readonly<Record<string, string>>) =>
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: (root) => {
          const repository = repositories[root];
          return Effect.succeed(repository === undefined ? null : gitHubIdentity(repository));
        },
      }),
    ),
  );

export const insertProject = (id: string, workspaceRoot: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES (${id}, ${id}, ${workspaceRoot}, '[]', ${CREATED_AT}, ${CREATED_AT})
    `,
  );

export const insertThread = (input: {
  readonly id: string;
  readonly projectId: string;
  readonly branch?: string | null;
  readonly updatedAt?: string;
  readonly deletedAt?: string | null;
}) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, branch, created_at, updated_at, deleted_at
      ) VALUES (
        ${input.id}, ${input.projectId}, ${input.id}, '{"instanceId":"codex","model":"gpt-5.4"}',
        ${input.branch ?? null}, ${CREATED_AT}, ${input.updatedAt ?? CREATED_AT},
        ${input.deletedAt ?? null}
      )
    `,
  );

export const insertPullRequestLink = (input: {
  readonly threadId: string;
  readonly repository: string;
  readonly number: number;
  readonly source?: "manual" | "stack-dismissed";
}) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      INSERT INTO projection_thread_pull_requests (thread_id, host, repository, number, url, source, linked_at)
      VALUES (${input.threadId}, 'github.com', ${input.repository}, ${input.number},
        ${`https://github.com/${input.repository}/pull/${input.number}`},
        ${input.source ?? "manual"}, ${CREATED_AT})
    `,
  );
