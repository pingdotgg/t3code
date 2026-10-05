import * as dataform from "@distilled.cloud/gcp/dataform_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  expandParent,
  hasAlchemyLabelMap,
  listReleaseConfigs,
  listRepositories,
  listWorkflowConfigs,
  listWorkflowInvocations,
  listWorkspaces,
  locationParent,
  normalizeLocation,
  parseResourceName,
  replaceOnIdentity,
  retryTransient,
  sameJson,
  sameText,
  toPhysicalId,
  updateMaskOf,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type GitRemoteSettings = {
  /** Git remote URL. */
  url?: string;
  /** Default branch name. Defaults to `main` when omitted. */
  defaultBranch?: string;
  /**
   * Secret Manager secret version used as a Git token
   * (`projects/{project}/secrets/{secret}/versions/{version}`).
   */
  authenticationTokenSecretVersion?: string;
  /**
   * Cloud Build `GitRepositoryLink` used for machine credentials
   * (`projects/{project}/locations/{location}/connections/{connection}/gitRepositoryLinks/{link}`).
   */
  gitRepositoryLink?: string;
  /** SSH host public key. */
  hostPublicKey?: string;
  /**
   * Secret Manager secret version holding the SSH private key
   * (`projects/{project}/secrets/{secret}/versions/{version}`).
   */
  userPrivateKeySecretVersion?: string;
};

export type WorkspaceCompilationOverrides = {
  /** Default database (Google Cloud project id). */
  defaultDatabase?: string;
  /** Suffix appended to schema (BigQuery dataset) names. */
  schemaSuffix?: string;
  /** Prefix prepended to table names. */
  tablePrefix?: string;
};

export type RepositoryProps = {
  /**
   * Repository id (the `{repository}` segment of
   * `projects/{project}/locations/{location}/repositories/{repository}`).
   * If omitted, a unique RFC1035 name is generated. Immutable — changing
   * it replaces the repository.
   */
  repositoryId?: string;
  /**
   * Region (`us-central1`, …). Immutable — changing it replaces the
   * repository. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * User-friendly display name. Defaults to the repository id.
   */
  displayName?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Parent folder or team folder
   * (`projects/{project}/locations/{location}/folders/{folder}` or
   * `.../teamFolders/{teamFolder}`). Changing it moves the repository.
   */
  containingFolder?: string;
  /**
   * Git remote. Omit for a Dataform-managed (non-linked) repository.
   */
  gitRemoteSettings?: GitRemoteSettings;
  /**
   * Secret Manager secret version interpolated into `.npmrc`
   * (`projects/{project}/secrets/{secret}/versions/{version}`).
   */
  npmrcEnvironmentVariablesSecretVersion?: string;
  /**
   * Service account used to run workflow invocations.
   */
  serviceAccount?: string;
  /**
   * Workspace compilation overrides for `dataform.json` defaults.
   */
  workspaceCompilationOverrides?: WorkspaceCompilationOverrides;
  /**
   * Customer-managed KMS key. Immutable after create.
   */
  kmsKeyName?: string;
  /**
   * Grant `roles/dataform.admin` to the caller on create.
   * @default true
   */
  setAuthenticatedUserAdmin?: boolean;
};

export type Repository = Resource<
  "GCP.Dataform.Repository",
  RepositoryProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/repositories/{repository}`. */
    name: string;
    /** Repository id (last path segment). */
    repositoryId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User-friendly display name. */
    displayName: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Parent folder or team folder, if any. */
    containingFolder: string | undefined;
    /** Associated team folder, if any. */
    teamFolderName: string | undefined;
    /** Git remote URL, if linked. */
    gitRemoteUrl: string | undefined;
    /** Effective default Git branch. */
    gitDefaultBranch: string | undefined;
    /** Service account for workflow invocations. */
    serviceAccount: string | undefined;
    /** Customer-managed KMS key, if set. */
    kmsKeyName: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Dataform Git repository — the container for workspaces, release
 * configs, workflow configs, and workflow invocations.
 *
 * Changing `repositoryId`, `location`, or `kmsKeyName` replaces the
 * repository. Display name, labels, Git remote, service account, npmrc
 * secret, and compilation overrides update in place. `containingFolder`
 * is applied with MoveRepository.
 *
 * ### Creating a Repository
 * **Example:** Generated name
 * ```typescript
 * const repo = yield* GCP.Dataform.Repository("Analytics", {
 *   labels: { env: "test" },
 * });
 * ```
 *
 * **Example:** Named repository
 * ```typescript
 * const repo = yield* GCP.Dataform.Repository("Analytics", {
 *   repositoryId: "analytics",
 *   location: "us-central1",
 *   displayName: "analytics",
 * });
 * ```
 *
 * @resource
 * @category Dataform
 */
export const Repository = Resource<Repository>("GCP.Dataform.Repository");

export class RepositoryNotResolved extends Data.TaggedError(
  "GCP.Dataform.RepositoryNotResolved",
)<{
  name: string;
}> {}

const resourceName = (
  project: string,
  location: string,
  repositoryId: string,
) => `${locationParent(project, location)}/repositories/${repositoryId}`;

const gitOf = (
  settings: GitRemoteSettings | undefined,
): dataform.GitRemoteSettings | undefined => {
  if (settings === undefined) return undefined;
  const ssh =
    settings.hostPublicKey !== undefined ||
    settings.userPrivateKeySecretVersion !== undefined
      ? {
          hostPublicKey: settings.hostPublicKey,
          userPrivateKeySecretVersion: settings.userPrivateKeySecretVersion,
        }
      : undefined;
  return {
    url: settings.url,
    defaultBranch: settings.defaultBranch,
    authenticationTokenSecretVersion: settings.authenticationTokenSecretVersion,
    gitRepositoryLink: settings.gitRepositoryLink,
    sshAuthenticationConfig: ssh,
  };
};

const toAttrs = (
  repo: dataform.Repository,
  project: string,
  region: string,
) => {
  const name = repo.name ?? "";
  const parsed = parseResourceName(name, "repositories", region);
  return {
    name,
    repositoryId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: repo.displayName,
    labels: userLabels(repo.labels),
    containingFolder: repo.containingFolder,
    teamFolderName: repo.teamFolderName,
    gitRemoteUrl: repo.gitRemoteSettings?.url,
    gitDefaultBranch:
      repo.gitRemoteSettings?.effectiveDefaultBranch ??
      repo.gitRemoteSettings?.defaultBranch,
    serviceAccount: repo.serviceAccount,
    kmsKeyName: repo.kmsKeyName,
    createTime: repo.createTime,
  };
};

const getByName = (name: string) =>
  name.length === 0 || name.includes("//")
    ? Effect.succeed(undefined)
    : dataform
        .getProjectsLocationsRepositories({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const RepositoryProvider = () =>
  Provider.succeed(Repository, {
    stables: [
      "name",
      "repositoryId",
      "project",
      "location",
      "kmsKeyName",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousKey = olds?.kmsKeyName ?? output?.kmsKeyName;
      return replaceOnIdentity({
        previousId: olds?.repositoryId ?? output?.repositoryId,
        nextId: news.repositoryId ?? olds?.repositoryId ?? output?.repositoryId,
        previousLocation: olds?.location ?? output?.location,
        nextLocation: news.location ?? olds?.location ?? output?.location,
        extra:
          previousKey !== undefined &&
          news.kmsKeyName !== undefined &&
          news.kmsKeyName !== previousKey,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const repositoryId = yield* toPhysicalId(
        id,
        olds?.repositoryId,
        output?.repositoryId,
      );
      const name =
        output?.name ?? resourceName(env.project, location, repositoryId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const repos = yield* listRepositories(env.project, env.region);
        return repos
          .filter((repo) => hasAlchemyLabelMap(repo.labels))
          .map((repo) => toAttrs(repo, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const repositoryId = yield* toPhysicalId(
        id,
        news.repositoryId,
        output?.repositoryId,
      );
      const name = resourceName(env.project, location, repositoryId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const displayName = news.displayName ?? repositoryId;
      const gitRemoteSettings = gitOf(news.gitRemoteSettings);
      const containingFolder =
        news.containingFolder !== undefined
          ? news.containingFolder.includes("/")
            ? news.containingFolder
            : expandParent(
                news.containingFolder,
                env.project,
                location,
                "folders",
              )
          : undefined;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* retryTransient(
          dataform.createProjectsLocationsRepositories({
            parent: locationParent(env.project, location),
            repositoryId,
            body: {
              displayName,
              labels: desiredLabels,
              containingFolder,
              gitRemoteSettings,
              npmrcEnvironmentVariablesSecretVersion:
                news.npmrcEnvironmentVariablesSecretVersion,
              serviceAccount: news.serviceAccount,
              workspaceCompilationOverrides: news.workspaceCompilationOverrides,
              kmsKeyName: news.kmsKeyName,
              setAuthenticatedUserAdmin: news.setAuthenticatedUserAdmin ?? true,
            },
          }),
        ).pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
        if (current === undefined) {
          current = yield* waitUntilExists(getByName(name), name);
        }
      }

      if (current === undefined) {
        return yield* new RepositoryNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const displayChanged = !sameText(current.displayName, displayName);
      const gitChanged = !sameJson(
        current.gitRemoteSettings
          ? {
              url: current.gitRemoteSettings.url,
              defaultBranch: current.gitRemoteSettings.defaultBranch,
              authenticationTokenSecretVersion:
                current.gitRemoteSettings.authenticationTokenSecretVersion,
              gitRepositoryLink: current.gitRemoteSettings.gitRepositoryLink,
              sshAuthenticationConfig:
                current.gitRemoteSettings.sshAuthenticationConfig,
            }
          : undefined,
        gitRemoteSettings,
      );
      const npmrcChanged = !sameText(
        current.npmrcEnvironmentVariablesSecretVersion,
        news.npmrcEnvironmentVariablesSecretVersion,
      );
      const serviceAccountChanged = !sameText(
        current.serviceAccount,
        news.serviceAccount,
      );
      const overridesChanged = !sameJson(
        current.workspaceCompilationOverrides,
        news.workspaceCompilationOverrides,
      );

      if (
        labelsChanged ||
        displayChanged ||
        gitChanged ||
        npmrcChanged ||
        serviceAccountChanged ||
        overridesChanged
      ) {
        current = yield* retryTransient(
          dataform.patchProjectsLocationsRepositories({
            name: currentName,
            updateMask: updateMaskOf(
              labelsChanged ? "labels" : undefined,
              displayChanged ? "displayName" : undefined,
              gitChanged ? "gitRemoteSettings" : undefined,
              npmrcChanged
                ? "npmrcEnvironmentVariablesSecretVersion"
                : undefined,
              serviceAccountChanged ? "serviceAccount" : undefined,
              overridesChanged ? "workspaceCompilationOverrides" : undefined,
            ),
            body: {
              displayName,
              labels: desiredLabels,
              gitRemoteSettings,
              npmrcEnvironmentVariablesSecretVersion:
                news.npmrcEnvironmentVariablesSecretVersion,
              serviceAccount: news.serviceAccount,
              workspaceCompilationOverrides: news.workspaceCompilationOverrides,
            },
          }),
        );
      }

      const observedFolder = current.containingFolder ?? "";
      const desiredFolder = containingFolder ?? "";
      if (desiredFolder !== observedFolder) {
        const moved = yield* retryTransient(
          dataform.moveProjectsLocationsRepositories({
            name: currentName,
            body: { destinationContainingFolder: desiredFolder },
          }),
        );
        yield* waitForOperation(moved);
        current = (yield* getByName(currentName)) ?? current;
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      const parent = output.name;
      const children = [
        ...(yield* listWorkspaces(parent)),
        ...(yield* listWorkflowInvocations(parent)),
        ...(yield* listWorkflowConfigs(parent)),
        ...(yield* listReleaseConfigs(parent)),
      ];
      yield* Effect.forEach(
        children,
        (child) => {
          const name = child.name ?? "";
          if (name.includes("/workspaces/")) {
            return dataform
              .deleteProjectsLocationsRepositoriesWorkspaces({ name })
              .pipe(
                Effect.catchTag(["NotFound", "BadRequest"], () => Effect.void),
              );
          }
          if (name.includes("/workflowInvocations/")) {
            return dataform
              .deleteProjectsLocationsRepositoriesWorkflowInvocations({
                name,
              })
              .pipe(
                Effect.catchTag(["NotFound", "BadRequest"], () => Effect.void),
              );
          }
          if (name.includes("/workflowConfigs/")) {
            return dataform
              .deleteProjectsLocationsRepositoriesWorkflowConfigs({ name })
              .pipe(
                Effect.catchTag(["NotFound", "BadRequest"], () => Effect.void),
              );
          }
          if (name.includes("/releaseConfigs/")) {
            return dataform
              .deleteProjectsLocationsRepositoriesReleaseConfigs({ name })
              .pipe(
                Effect.catchTag(["NotFound", "BadRequest"], () => Effect.void),
              );
          }
          return Effect.void;
        },
        { concurrency: 4 },
      );
      yield* retryTransient(
        dataform.deleteProjectsLocationsRepositories({
          name: output.name,
          force: true,
        }),
      ).pipe(
        Effect.retry({
          while: (error) => error._tag === "Conflict",
          times: 8,
          schedule: Schedule.spaced("2 seconds"),
        }),
        Effect.catchTag("NotFound", () => Effect.void),
      );
      yield* waitUntilGone(getByName(output.name));
    }),
  });
