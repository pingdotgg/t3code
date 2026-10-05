import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { listLocations } from "./names.ts";
import { resourceNameFromOperation, waitForOperation } from "./operations.ts";
import {
  encodeOwnership,
  hasOwnershipMarker,
  lastSegment,
  locationOf,
  locationParent,
  ownedByAlchemy,
  parseOwnership,
  toResourceId,
} from "./ownership.ts";

export type McpTool = {
  /**
   * MCP server resource name
   * (`projects/{project}/locations/{location}/mcpServers/{mcp_server}`).
   */
  mcpServer?: string;
  /** MCP tool resource names. Omit to apply to every tool on the server. */
  tools?: string[];
};

export type SemanticGovernancePolicyProps = {
  /**
   * Region (`us-central1`, …). Immutable — changing it replaces the
   * policy.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Policy id (the `{semantic_governance_policy}` segment). If omitted, a
   * unique id is generated. Immutable.
   */
  semanticGovernancePolicyId?: string;
  /**
   * User-facing display name.
   */
  displayName?: string;
  /**
   * Human-readable description. SemanticGovernancePolicy has no labels
   * field, so Alchemy ownership is stored in a `[alchemy …]` prefix.
   */
  description?: string;
  /**
   * Agent Registry resource name affected by this policy.
   */
  agent: string;
  /**
   * Natural-language constraint enforced by the policy.
   */
  naturalLanguageConstraint: string;
  /**
   * Optional MCP tools the policy applies to.
   */
  mcpTools?: McpTool[];
};

export type SemanticGovernancePolicy = Resource<
  "GCP.AIPlatform.SemanticGovernancePolicy",
  SemanticGovernancePolicyProps,
  {
    /** Full resource name. */
    name: string;
    /** Policy id (last path segment). */
    semanticGovernancePolicyId: string;
    /** Region id. */
    location: string;
    /** Project id. */
    project: string;
    /** User-facing display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Agent Registry resource name. */
    agent: string | undefined;
    /** Natural-language constraint. */
    naturalLanguageConstraint: string | undefined;
    /** Agent identity used by the PDP. */
    agentIdentity: string | undefined;
    /** MCP tools covered by the policy. */
    mcpTools: McpTool[];
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex AI SemanticGovernancePolicy constraining an Agent's tools.
 *
 * Policies have no labels field — Alchemy stamps ownership into the
 * description. Location and policy id are immutable.
 *
 * ### Creating a Policy
 * **Example:** Natural-language constraint on an agent
 * ```typescript
 * const policy = yield* GCP.AIPlatform.SemanticGovernancePolicy("Safety", {
 *   agent: "projects/my-project/locations/us-central1/agents/support",
 *   naturalLanguageConstraint: "Never share customer PII.",
 * });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const SemanticGovernancePolicy = Resource<SemanticGovernancePolicy>(
  "GCP.AIPlatform.SemanticGovernancePolicy",
);

export class SemanticGovernancePolicyNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.SemanticGovernancePolicyNotResolved",
)<{
  name: string;
}> {}

const resourceName = (parent: string, policyId: string) =>
  `${parent}/semanticGovernancePolicies/${policyId}`;

const toAttrs = (
  policy: aiplatform.GoogleCloudAiplatformV1SemanticGovernancePolicy,
  project: string,
) => {
  const name = policy.name ?? "";
  const parsed = parseOwnership(policy.description);
  return {
    name,
    semanticGovernancePolicyId: lastSegment(name),
    location: locationOf(name),
    project,
    displayName: policy.displayName,
    description: parsed.text,
    agent: policy.agent,
    naturalLanguageConstraint: policy.naturalLanguageConstraint,
    agentIdentity: policy.agentIdentity,
    mcpTools: (policy.mcpTools ?? []).map((tool) => ({
      mcpServer: tool.mcpServer,
      tools: tool.tools,
    })),
    createTime: policy.createTime,
    updateTime: policy.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : aiplatform
        .getProjectsLocationsSemanticGovernancePolicies({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((policy) =>
      policy
        ? Effect.succeed(policy)
        : Effect.fail(new SemanticGovernancePolicyNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.AIPlatform.SemanticGovernancePolicyNotResolved",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const listAt = (parent: string, project: string) =>
  aiplatform.listProjectsLocationsSemanticGovernancePolicies
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.semanticGovernancePolicies ?? []),
      ),
      Stream.filter((policy) => hasOwnershipMarker(policy.description)),
      Stream.map((policy) => toAttrs(policy, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const mcpKey = (tools: McpTool[] | undefined) =>
  JSON.stringify(
    (tools ?? []).map((tool) => ({
      mcpServer: tool.mcpServer ?? "",
      tools: [...(tool.tools ?? [])].sort(),
    })),
  );

export const SemanticGovernancePolicyProvider = () =>
  Provider.succeed(SemanticGovernancePolicy, {
    stables: [
      "name",
      "semanticGovernancePolicyId",
      "location",
      "project",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousLocation = olds?.location ?? output?.location;
      const nextLocation = news.location ?? previousLocation;
      if (previousLocation !== undefined && previousLocation !== nextLocation) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId =
        olds?.semanticGovernancePolicyId ?? output?.semanticGovernancePolicyId;
      if (
        previousId !== undefined &&
        news.semanticGovernancePolicyId !== undefined &&
        news.semanticGovernancePolicyId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const policyId = yield* toResourceId(
        id,
        olds?.semanticGovernancePolicyId,
        output?.semanticGovernancePolicyId,
      );
      const location = olds?.location ?? output?.location ?? env.region;
      const name =
        output?.name ??
        resourceName(locationParent(env.project, location), policyId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return (yield* Effect.forEach(listLocations(env.region), (location) =>
          listAt(locationParent(env.project, location), env.project),
        )).flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = news.location ?? output?.location ?? env.region;
      const parent = locationParent(env.project, location);
      const policyId = yield* toResourceId(
        id,
        news.semanticGovernancePolicyId,
        output?.semanticGovernancePolicyId,
      );
      const name = resourceName(parent, policyId);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeOwnership(ownership, news.description);
      const displayName = news.displayName ?? policyId;
      const mcpTools = news.mcpTools?.map((tool) => ({
        mcpServer: tool.mcpServer,
        tools: tool.tools,
      }));

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* aiplatform
          .createProjectsLocationsSemanticGovernancePolicies({
            parent,
            semanticGovernancePolicyId: policyId,
            body: {
              displayName,
              description: desiredDescription,
              agent: news.agent,
              naturalLanguageConstraint: news.naturalLanguageConstraint,
              mcpTools,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          const done = yield* waitForOperation(created, {
            alreadyExistsOk: true,
          });
          const createdName = resourceNameFromOperation(done) ?? name;
          current = yield* waitUntilExists(createdName);
        } else {
          current = yield* getByName(name);
        }
      }

      if (current === undefined) {
        return yield* new SemanticGovernancePolicyNotResolved({ name });
      }

      const displayChanged = (current.displayName ?? "") !== displayName;
      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const agentChanged = (current.agent ?? "") !== news.agent;
      const constraintChanged =
        (current.naturalLanguageConstraint ?? "") !==
        news.naturalLanguageConstraint;
      const mcpChanged = mcpKey(current.mcpTools) !== mcpKey(news.mcpTools);

      if (
        displayChanged ||
        descriptionChanged ||
        agentChanged ||
        constraintChanged ||
        mcpChanged
      ) {
        const patched =
          yield* aiplatform.patchProjectsLocationsSemanticGovernancePolicies({
            name,
            updateMask: [
              displayChanged ? "displayName" : undefined,
              descriptionChanged ? "description" : undefined,
              agentChanged ? "agent" : undefined,
              constraintChanged ? "naturalLanguageConstraint" : undefined,
              mcpChanged ? "mcpTools" : undefined,
            ]
              .filter((field): field is string => field !== undefined)
              .join(","),
            body: {
              name,
              displayName,
              description: desiredDescription,
              agent: news.agent,
              naturalLanguageConstraint: news.naturalLanguageConstraint,
              mcpTools,
              etag: current.etag,
            },
          });
        yield* waitForOperation(patched);
        current = yield* waitUntilExists(name);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getByName(output.name);
      if (existing === undefined) return;
      const operation = yield* aiplatform
        .deleteProjectsLocationsSemanticGovernancePolicies({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
    }),
  });
