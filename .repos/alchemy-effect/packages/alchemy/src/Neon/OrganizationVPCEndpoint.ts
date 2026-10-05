import * as Neon from "@distilled.cloud/neon";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { OwnedBySomeoneElse, Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";

export interface OrganizationVPCEndpointProps {
  /** Existing Neon organization ID. Changing it replaces the registration, cleaning up the old scope first. */
  orgId: string;
  /** Neon AWS region ID, such as aws-us-east-2. Azure is not supported. Changes replace the registration. */
  regionId: string;
  /** Existing AWS VPC endpoint ID, not a VPC ID. Changes replace the registration. */
  vpcEndpointId: string;
  /** Descriptive label on the Neon registration. */
  label: string;
}

export interface OrganizationVPCEndpointAttributes {
  /** Organization containing the registration. */
  orgId: string;
  /** Neon AWS region containing the registration. */
  regionId: string;
  /** Referenced AWS VPC endpoint; never created, modified, or deleted by this resource. */
  vpcEndpointId: string;
  /** Observed label, or null when the registration is absent. */
  label: string | null;
  /** Original adopted label; null denotes a registration created by Alchemy. */
  initialLabel: string | null;
  /** Last managed label, retained across refreshes for drift-safe cleanup. */
  managedLabel: string;
  /** Observed Neon registration state (for example new or accepted); null when absent. */
  state: string | null;
}

export interface OrganizationVPCEndpoint extends Resource<
  "Neon.OrganizationVPCEndpoint",
  OrganizationVPCEndpointProps,
  OrganizationVPCEndpointAttributes,
  never,
  Providers
> {}

/**
 * Register an EXISTING AWS PrivateLink endpoint with a Neon organization.
 * Requires an entitled organization admin and a supported AWS region matching
 * the endpoint and client. Azure is unsupported. Neon allows at most ten
 * private networking configurations per AWS region. This neither provisions
 * the AWS endpoint nor configures its DNS, and does not block public connections.
 *
 * Existing registrations require explicit resource-scoped adoption. Their label
 * is durably captured before mutation and restored on destroy, without revoking
 * the registration. New registrations are unregistered on destroy only if their
 * label is still managed and no projects restrict access through them.
 * IMPORTANT: Neon permanently prevents re-registering a removed endpoint in the
 * same organization. Replacement cleans up the old scope first; use a fresh AWS
 * endpoint when necessary. External drift blocks cleanup. Preserve the state
 * store and serialize writers: Neon exposes no conditional association writes.
 *
 * ### Register private networking
 * **Example:** Bind an existing AWS endpoint
 * ```typescript
 * const network = yield* Neon.OrganizationVPCEndpoint("PrivateNetwork", {
 *   orgId: "org-example-12345678",
 *   regionId: "aws-us-east-2",
 *   vpcEndpointId: "vpce-0123456789abcdef0",
 *   label: "Application network",
 * });
 * ```
 *
 * @resource
 * @product Organization
 */
export const OrganizationVPCEndpoint = Resource<OrganizationVPCEndpoint>(
  "Neon.OrganizationVPCEndpoint",
);

export class InvalidOrganizationVPCEndpoint extends Data.TaggedError(
  "InvalidOrganizationVPCEndpoint",
)<{
  /** Invalid scope or unsafe mutation condition. */
  message: string;
}> {}

/** @internal */
export const validateOrganizationVPCEndpoint = (
  props: OrganizationVPCEndpointProps,
) =>
  /^[a-z0-9-]{1,60}$/.test(props.orgId) &&
  /^aws-[a-z0-9-]+$/.test(props.regionId) &&
  /^vpce-[a-f0-9]+$/.test(props.vpcEndpointId) &&
  props.label.trim().length > 0
    ? Effect.void
    : Effect.fail(
        new InvalidOrganizationVPCEndpoint({
          message:
            "An organization ID, AWS Neon region, existing vpce- endpoint ID, and nonempty label are required",
        }),
      );

const request = (scope: {
  orgId: string;
  regionId: string;
  vpcEndpointId: string;
}) => ({
  org_id: scope.orgId,
  region_id: scope.regionId,
  vpc_endpoint_id: scope.vpcEndpointId,
});

const observe = (scope: {
  orgId: string;
  regionId: string;
  vpcEndpointId: string;
}) =>
  Neon.getOrganizationVPCEndpointDetails(request(scope)).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

export const OrganizationVPCEndpointProvider = () =>
  Provider.succeed(OrganizationVPCEndpoint, {
    stables: ["orgId", "regionId", "vpcEndpointId", "initialLabel"],
    diff: Effect.fn(function* ({ olds, news, output }) {
      const previous = output ?? olds;
      if (
        !("orgId" in news) ||
        !("regionId" in news) ||
        !("vpcEndpointId" in news)
      ) {
        return { action: "replace", deleteFirst: true } as const;
      }
      for (const key of ["orgId", "regionId", "vpcEndpointId"] as const) {
        if (!isResolved(news[key]) || news[key] !== previous[key]) {
          return { action: "replace", deleteFirst: true } as const;
        }
      }
      if (!isResolved<OrganizationVPCEndpointProps>(news)) return;
      yield* validateOrganizationVPCEndpoint(news);
      if ((yield* observe(news))?.label !== news.label) {
        return { action: "update" } as const;
      }
    }),
    read: Effect.fn(function* ({ olds, output }) {
      const scope = output ?? olds;
      if (!scope?.orgId || !scope.regionId || !scope.vpcEndpointId) return;
      const observed = yield* observe(scope);
      if (output)
        return {
          ...output,
          label: observed?.label ?? null,
          state: observed?.state ?? null,
        };
      if (!observed) return;
      return Unowned({
        orgId: scope.orgId,
        regionId: scope.regionId,
        vpcEndpointId: scope.vpcEndpointId,
        label: observed.label,
        initialLabel: observed.label,
        managedLabel: observed.label,
        state: observed.state,
      });
    }),
    reconcile: Effect.fn(function* ({ news, output, olds }) {
      yield* validateOrganizationVPCEndpoint(news);
      if (
        output &&
        (output.orgId !== news.orgId ||
          output.regionId !== news.regionId ||
          output.vpcEndpointId !== news.vpcEndpointId)
      ) {
        return yield* new InvalidOrganizationVPCEndpoint({
          message: "Registration identity changed without replacement",
        });
      }
      const observed = yield* observe(news);
      if (observed && !output) {
        return yield* new OwnedBySomeoneElse({
          message:
            "Existing VPC registration requires scoped adoption; an equal endpoint ID is not ownership",
          resourceType: "Neon.OrganizationVPCEndpoint",
        });
      }
      if (
        output &&
        !olds &&
        observed?.label !== output.managedLabel &&
        observed?.label !== news.label
      ) {
        return yield* new InvalidOrganizationVPCEndpoint({
          message:
            "VPC registration changed since its adoption baseline was captured",
        });
      }
      if (!observed && output) {
        return yield* new InvalidOrganizationVPCEndpoint({
          message:
            "The registration was removed externally; Neon forbids re-registering it in this organization",
        });
      }
      if (observed?.label !== news.label) {
        yield* Neon.assignOrganizationVPCEndpoint({
          ...request(news),
          label: news.label,
        }).pipe(
          Effect.catchTag(
            "Conflict",
            Effect.fn(function* (error) {
              const raced = yield* observe(news);
              if (!raced || raced.label !== news.label) return yield* error;
              if (!output)
                return yield* new OwnedBySomeoneElse({
                  message:
                    "A registration appeared during creation; explicit adoption is required",
                  resourceType: "Neon.OrganizationVPCEndpoint",
                });
            }),
          ),
        );
      }
      const current = yield* observe(news);
      if (!current || current.label !== news.label) {
        return yield* new InvalidOrganizationVPCEndpoint({
          message: "VPC registration changed during reconciliation",
        });
      }
      return {
        orgId: news.orgId,
        regionId: news.regionId,
        vpcEndpointId: news.vpcEndpointId,
        label: current.label,
        initialLabel: output?.initialLabel ?? null,
        managedLabel: news.label,
        state: current.state,
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
        return yield* new InvalidOrganizationVPCEndpoint({
          message:
            "Refusing cleanup of an externally relabeled VPC registration",
        });
      }
      if (output.initialLabel !== null) {
        yield* Neon.assignOrganizationVPCEndpoint({
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
        if (observed.num_restricted_projects !== 0) {
          return yield* new InvalidOrganizationVPCEndpoint({
            message:
              "Remove project VPC restrictions before unregistering this endpoint",
          });
        }
        yield* Neon.deleteOrganizationVPCEndpoint(request(output)).pipe(
          Effect.catchTag("NotFound", () => Effect.void),
        );
      }
    }),
  });
