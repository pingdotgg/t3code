import * as Neon from "@distilled.cloud/neon";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { OwnedBySomeoneElse, Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { validateOrganizationVPCEndpoint } from "./OrganizationVPCEndpoint.ts";
import type { Providers } from "./Providers.ts";

export interface ProjectVPCEndpointProps {
  /** Project to restrict. Changing the project replaces the association, cleaning up the old scope first. */
  project: {
    /** Neon project identity. */
    projectId: string;
  };
  /** Already configured organization VPC endpoint in the project's organization and AWS region. */
  endpoint: {
    /** Existing Neon organization identity. */
    orgId: string;
    /** Neon AWS region identity. */
    regionId: string;
    /** Existing registered AWS VPC endpoint identity. */
    vpcEndpointId: string;
  };
  /** Descriptive label for this project restriction. */
  label: string;
}

export interface ProjectVPCEndpointAttributes {
  /** Restricted project identity. */
  projectId: string;
  /** Organization containing the project and registered endpoint. */
  orgId: string;
  /** AWS Neon region shared by the project and registered endpoint. */
  regionId: string;
  /** Registered AWS VPC endpoint identity. */
  vpcEndpointId: string;
  /** Observed restriction label, or null when absent. */
  label: string | null;
  /** Original adopted restriction label; null means Alchemy created the restriction. */
  initialLabel: string | null;
  /** Last managed label, retained across refreshes for drift-safe cleanup. */
  managedLabel: string;
}

export interface ProjectVPCEndpoint extends Resource<
  "Neon.ProjectVPCEndpoint",
  ProjectVPCEndpointProps,
  ProjectVPCEndpointAttributes,
  never,
  Providers
> {}

/**
 * Manage one project's restriction to an already registered organization VPC
 * endpoint. Requires an organization admin entitled to AWS Private Networking.
 * The project, endpoint, and client must share an AWS region and the endpoint
 * must belong to the project's organization. Azure is unsupported.
 * This does not change the AWS endpoint, its organization registration, or
 * the project's separate block_public_connections setting. Other restrictions
 * are left untouched. Removing the last restriction can broaden connectivity.
 *
 * Existing associations require explicit resource-scoped adoption. Their
 * original label is durably captured before mutation and restored on destroy;
 * an adopted restriction is never silently removed. New restrictions are
 * removed on destroy only when their label still matches the managed value.
 * Scope changes replace with old-scope cleanup first, avoiding stale managed
 * grants. Preserve state and serialize writers; Neon has no conditional writes.
 *
 * ### Restrict a project
 * **Example:** Reference an organization registration
 * ```typescript
 * const restriction = yield* Neon.ProjectVPCEndpoint("PrivateAccess", {
 *   project,
 *   endpoint: network,
 *   label: "Application access",
 * });
 * ```
 *
 * @resource
 * @product Project
 */
export const ProjectVPCEndpoint = Resource<ProjectVPCEndpoint>(
  "Neon.ProjectVPCEndpoint",
);

export class InvalidProjectVPCEndpoint extends Data.TaggedError(
  "InvalidProjectVPCEndpoint",
)<{
  /** Invalid scope or unsafe mutation condition. */
  message: string;
}> {}

/** @internal */
export const validateProjectVPCEndpoint = Effect.fn(function* (
  props: ProjectVPCEndpointProps,
) {
  if (!props.project.projectId.trim()) {
    return yield* new InvalidProjectVPCEndpoint({
      message: "A project ID is required",
    });
  }
  yield* validateOrganizationVPCEndpoint({
    ...props.endpoint,
    label: props.label,
  });
});

const scopeOf = (props: ProjectVPCEndpointProps) => ({
  projectId: props.project.projectId,
  orgId: props.endpoint.orgId,
  regionId: props.endpoint.regionId,
  vpcEndpointId: props.endpoint.vpcEndpointId,
});

const request = (scope: { projectId: string; vpcEndpointId: string }) => ({
  project_id: scope.projectId,
  vpc_endpoint_id: scope.vpcEndpointId,
});

const observe = (scope: { projectId: string; vpcEndpointId: string }) =>
  Neon.listProjectVPCEndpoints({ project_id: scope.projectId }).pipe(
    Effect.map((result) =>
      result.endpoints.find(
        (endpoint) => endpoint.vpc_endpoint_id === scope.vpcEndpointId,
      ),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const validateCloudScope = Effect.fn(function* (scope: {
  projectId: string;
  orgId: string;
  regionId: string;
  vpcEndpointId: string;
}) {
  const { project } = yield* Neon.getProject({ project_id: scope.projectId });
  if (project.org_id !== scope.orgId || project.region_id !== scope.regionId) {
    return yield* new InvalidProjectVPCEndpoint({
      message:
        "Project and registered endpoint must share an organization and AWS region",
    });
  }
  yield* Neon.getOrganizationVPCEndpointDetails({
    org_id: scope.orgId,
    region_id: scope.regionId,
    vpc_endpoint_id: scope.vpcEndpointId,
  });
});

export const ProjectVPCEndpointProvider = () =>
  Provider.succeed(ProjectVPCEndpoint, {
    stables: [
      "projectId",
      "orgId",
      "regionId",
      "vpcEndpointId",
      "initialLabel",
    ],
    diff: Effect.fn(function* ({ olds, news, output }) {
      const previous = output ?? scopeOf(olds);
      if (
        !("project" in news) ||
        !("endpoint" in news) ||
        !isResolved(news.project) ||
        !isResolved(news.endpoint) ||
        news.project.projectId !== previous.projectId ||
        news.endpoint.orgId !== previous.orgId ||
        news.endpoint.regionId !== previous.regionId ||
        news.endpoint.vpcEndpointId !== previous.vpcEndpointId
      )
        return { action: "replace", deleteFirst: true } as const;
      if (!isResolved<ProjectVPCEndpointProps>(news)) return;
      yield* validateProjectVPCEndpoint(news);
      const scope = scopeOf(news);
      yield* validateCloudScope(scope);
      if ((yield* observe(scope))?.label !== news.label) {
        return { action: "update" } as const;
      }
    }),
    read: Effect.fn(function* ({ olds, output }) {
      if (
        !output &&
        (!olds?.project?.projectId ||
          !olds.endpoint?.orgId ||
          !olds.endpoint.regionId ||
          !olds.endpoint.vpcEndpointId)
      )
        return;
      const scope = output ?? scopeOf(olds);
      const observed = yield* observe(scope);
      if (output) return { ...output, label: observed?.label ?? null };
      if (!observed) return;
      yield* validateCloudScope(scope);
      return Unowned({
        ...scope,
        label: observed.label,
        initialLabel: observed.label,
        managedLabel: observed.label,
      });
    }),
    reconcile: Effect.fn(function* ({ news, output, olds }) {
      yield* validateProjectVPCEndpoint(news);
      const scope = scopeOf(news);
      if (
        output &&
        (output.projectId !== scope.projectId ||
          output.orgId !== scope.orgId ||
          output.regionId !== scope.regionId ||
          output.vpcEndpointId !== scope.vpcEndpointId)
      )
        return yield* new InvalidProjectVPCEndpoint({
          message: "Restriction identity changed without replacement",
        });
      yield* validateCloudScope(scope);
      const observed = yield* observe(scope);
      if (observed && !output)
        return yield* new OwnedBySomeoneElse({
          message:
            "Existing project VPC restriction requires scoped adoption; an equal endpoint ID is not ownership",
          resourceType: "Neon.ProjectVPCEndpoint",
        });
      if (
        output &&
        !olds &&
        observed?.label !== output.managedLabel &&
        observed?.label !== news.label
      ) {
        return yield* new InvalidProjectVPCEndpoint({
          message:
            "Project restriction changed since its adoption baseline was captured",
        });
      }
      if (observed?.label !== news.label) {
        yield* Neon.assignProjectVPCEndpoint({
          ...request(scope),
          label: news.label,
        }).pipe(
          Effect.catchTag(
            "Conflict",
            Effect.fn(function* (error) {
              const raced = yield* observe(scope);
              if (!raced || raced.label !== news.label) return yield* error;
              if (!output)
                return yield* new OwnedBySomeoneElse({
                  message:
                    "A project restriction appeared during creation; explicit adoption is required",
                  resourceType: "Neon.ProjectVPCEndpoint",
                });
            }),
          ),
        );
      }
      const current = yield* observe(scope);
      if (!current || current.label !== news.label)
        return yield* new InvalidProjectVPCEndpoint({
          message: "Project restriction changed during reconciliation",
        });
      return {
        ...scope,
        label: current.label,
        initialLabel: output?.initialLabel ?? null,
        managedLabel: news.label,
      };
    }),
    delete: Effect.fn(function* ({ output, olds }) {
      const observed = yield* observe(output);
      if (!observed) return;
      if (
        output.initialLabel !== null &&
        observed.label === output.initialLabel
      )
        return;
      if (
        observed.label !== output.managedLabel &&
        observed.label !== olds.label
      ) {
        return yield* new InvalidProjectVPCEndpoint({
          message:
            "Refusing cleanup of an externally relabeled project restriction",
        });
      }
      // A transferred project must not be mutated under its previous organization.
      const exists = yield* validateCloudScope(output).pipe(
        Effect.as(true),
        Effect.catchTag(
          "NotFound",
          Effect.fn(function* (error) {
            if (yield* observe(output)) return yield* error;
            return false;
          }),
        ),
      );
      if (!exists) return;
      if (output.initialLabel !== null) {
        yield* Neon.assignProjectVPCEndpoint({
          ...request(output),
          label: output.initialLabel,
        }).pipe(
          Effect.catchTag(
            "NotFound",
            Effect.fn(function* (error) {
              if (yield* observe(output)) return yield* error;
            }),
          ),
        );
      } else {
        yield* Neon.deleteProjectVPCEndpoint(request(output)).pipe(
          Effect.catchTag("NotFound", () => Effect.void),
        );
      }
    }),
  });
