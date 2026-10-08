import * as dialogflow from "@distilled.cloud/gcp/dialogflow_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnership,
  expandName,
  listAgents,
  listEnvironments,
  normalizeLocation,
  ownedByAlchemy,
  ownershipLabels,
  ownershipText,
  parseOwnership,
  parseResourceName,
  resourceNameFromOperation,
  sameJson,
  sameText,
  updateMaskOf,
  waitForOperation,
  retryQuota,
} from "./internal.ts";

export type EnvironmentVersionConfig = {
  /**
   * Flow version resource name
   * `projects/{project}/locations/{location}/agents/{agent}/flows/{flow}/versions/{version}`.
   */
  version: string;
};

export type AgentsEnvironmentProps = {
  /**
   * Parent agent resource name
   * `projects/{project}/locations/{location}/agents/{agent}`. Immutable —
   * changing it replaces the environment.
   */
  agent: string;
  /**
   * Environment id (the `{environment}` segment). Server-assigned on
   * create. Immutable — changing it replaces the environment.
   */
  environmentId?: string;
  /**
   * Location used when `agent` is a bare id.
   * @default "global"
   */
  location?: string;
  /** Human-readable name, unique within the agent. */
  displayName?: string;
  /**
   * Description. Environments have no labels field, so Alchemy stamps
   * ownership into this field for `list` / nuke.
   */
  description?: string;
  /**
   * Flow versions served by this environment. Must include a version of
   * every flow reachable from the start flow.
   */
  versionConfigs: EnvironmentVersionConfig[];
};

export type AgentsEnvironment = Resource<
  "GCP.Dialogflow.AgentsEnvironment",
  AgentsEnvironmentProps,
  {
    /** Full resource name. */
    name: string;
    /** Environment id (last path segment). */
    environmentId: string;
    /** Parent agent resource name. */
    agent: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Served flow versions. */
    versionConfigs: EnvironmentVersionConfig[];
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Dialogflow CX environment under an agent.
 *
 * Environments have no labels field, so Alchemy stamps ownership into
 * `description` for `list` / nuke. Parent agent and environment id are
 * immutable. Display name, description, and version configs update in
 * place. Create and update are long-running operations.
 *
 * ### Creating an Environment
 * **Example:** Serve a flow version
 * ```typescript
 * const version = yield* GCP.Dialogflow.AgentsFlowsVersion("V1", {
 *   flow: agent.startFlow,
 *   displayName: "v1",
 * });
 * const environment = yield* GCP.Dialogflow.AgentsEnvironment("Prod", {
 *   agent: agent.name,
 *   displayName: "prod",
 *   versionConfigs: [{ version: version.name }],
 * });
 * ```
 *
 * @resource
 * @category Dialogflow
 */
export const AgentsEnvironment = Resource<AgentsEnvironment>(
  "GCP.Dialogflow.AgentsEnvironment",
);

export class AgentsEnvironmentNotResolved extends Data.TaggedError(
  "GCP.Dialogflow.AgentsEnvironmentNotResolved",
)<{
  name: string;
}> {}

const configsOf = (
  list:
    | readonly dialogflow.GoogleCloudDialogflowCxV3EnvironmentVersionConfig[]
    | undefined,
): EnvironmentVersionConfig[] =>
  (list ?? [])
    .filter((config) => (config.version ?? "").length > 0)
    .map((config) => ({ version: config.version ?? "" }));

const toAttrs = (
  environment: dialogflow.GoogleCloudDialogflowCxV3Environment,
  project: string,
) => {
  const name = environment.name ?? "";
  const parsed = parseResourceName(name, "environments");
  return {
    name,
    environmentId: parsed.id,
    agent: parsed.agent,
    project: parsed.project || project,
    location: parsed.location,
    displayName: environment.displayName,
    description: parseOwnership(environment.description).text,
    versionConfigs: configsOf(environment.versionConfigs),
    updateTime: environment.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : dialogflow
        .getProjectsLocationsAgentsEnvironments({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const findOwned = (id: string, agent: string, hinted?: string) =>
  Effect.gen(function* () {
    if (hinted !== undefined && hinted.length > 0) {
      const existing = yield* getByName(hinted);
      if (existing !== undefined) return existing;
    }
    const environments = yield* listEnvironments(agent);
    for (const environment of environments) {
      if (yield* ownedByAlchemy(id, ownershipText(environment))) {
        return environment;
      }
    }
    return undefined as
      | dialogflow.GoogleCloudDialogflowCxV3Environment
      | undefined;
  });

const resolveFromOperation = (
  operation: dialogflow.GoogleLongrunningOperation,
) =>
  Effect.gen(function* () {
    const done = yield* waitForOperation(operation);
    const name =
      resourceNameFromOperation(done) ?? resourceNameFromOperation(operation);
    if (name === undefined) return undefined;
    return yield* getByName(name);
  });

export const AgentsEnvironmentProvider = () =>
  Provider.succeed(AgentsEnvironment, {
    stables: ["name", "environmentId", "agent", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousAgent = olds?.agent ?? output?.agent;
      const previousId = olds?.environmentId ?? output?.environmentId;
      if (
        (previousAgent !== undefined && news.agent !== previousAgent) ||
        (previousId !== undefined &&
          news.environmentId !== undefined &&
          news.environmentId !== previousId)
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousAgent === news.agent &&
            previousId !== undefined &&
            news.environmentId === previousId,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const agent = olds?.agent ?? output?.agent;
      const existing =
        output?.name !== undefined
          ? yield* getByName(output.name)
          : agent !== undefined
            ? yield* findOwned(id, agent)
            : undefined;
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, ownershipText(existing)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const agents = yield* listAgents(env.project);
        const pages = yield* Effect.forEach(
          agents,
          (agent) =>
            agent.name
              ? listEnvironments(agent.name).pipe(
                  Effect.map((environments) =>
                    environments
                      .filter(
                        (environment) =>
                          parseOwnership(environment.description).labels[
                            "alchemy-id"
                          ] !== undefined ||
                          parseOwnership(environment.displayName).labels[
                            "alchemy-id"
                          ] !== undefined,
                      )
                      .map((environment) => toAttrs(environment, env.project)),
                  ),
                )
              : Effect.succeed([]),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(news.location ?? output?.location);
      const agent = expandName(news.agent, env.project, location, "agents");
      const ownership = yield* ownershipLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const displayName = news.displayName ?? "environment";
      const versionConfigs = news.versionConfigs;
      const body: dialogflow.GoogleCloudDialogflowCxV3Environment = {
        displayName,
        description,
        versionConfigs,
      };

      let current = yield* findOwned(id, agent, output?.name);

      if (current === undefined) {
        const operation = yield* dialogflow
          .createProjectsLocationsAgentsEnvironments({
            parent: agent,
            body,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (operation !== undefined) {
          current = yield* resolveFromOperation(operation);
        }
        if (current === undefined) {
          current = yield* findOwned(id, agent, output?.name);
        }
      }

      if (current === undefined) {
        return yield* new AgentsEnvironmentNotResolved({
          name:
            output?.name ??
            `${agent}/environments/${news.environmentId ?? "unknown"}`,
        });
      }

      const currentName = current.name ?? output?.name ?? "";
      const displayChanged = !sameText(current.displayName, displayName);
      const descriptionChanged = !sameText(current.description, description);
      const versionsChanged = !sameJson(
        configsOf(current.versionConfigs),
        configsOf(versionConfigs),
      );

      if (displayChanged || descriptionChanged || versionsChanged) {
        const operation =
          yield* dialogflow.patchProjectsLocationsAgentsEnvironments({
            name: currentName,
            updateMask: updateMaskOf(
              displayChanged ? "display_name" : undefined,
              descriptionChanged ? "description" : undefined,
              versionsChanged ? "version_configs" : undefined,
            ),
            body: { ...body, name: currentName },
          });
        const patched = yield* resolveFromOperation(operation);
        current = patched ?? (yield* getByName(currentName)) ?? current;
      }

      return toAttrs(current, env.project);
    }, retryQuota),

    delete: Effect.fn(function* ({ output }) {
      yield* dialogflow
        .deleteProjectsLocationsAgentsEnvironments({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }, retryQuota),
  });
