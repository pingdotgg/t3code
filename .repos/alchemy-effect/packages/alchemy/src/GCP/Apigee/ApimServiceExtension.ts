import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  hasOwnershipExtension,
  parseOwnershipExtension,
  stripOwnershipExtension,
  withOwnershipExtension,
} from "./ownership.ts";
import {
  lastSegment,
  orgParent,
  resolveOrgId,
  sameJson,
  toPhysicalId,
  waitForOperation,
} from "./operations.ts";

const MAX_NAME_LENGTH = 63;

export type ApimNetworkConfig = {
  /**
   * Region for the PSC NEG.
   */
  region: string;
  /**
   * Subnet for the PSC NEG
   * (`projects/{project}/regions/{region}/subnetworks/{subnet}`).
   */
  subnet: string;
};

export type ApimExtension = {
  /**
   * `LbTrafficExtension` resource name (RFC-1034, max 63 characters).
   */
  name: string;
  /**
   * Hostname of an Apigee environment group used to route traffic.
   */
  hostname: string;
  /**
   * Whether matching requests should fail open.
   */
  failOpen?: boolean;
  /**
   * CEL match condition.
   */
  matchCondition?: string;
  /**
   * Supported events. Empty means all events.
   */
  supportedEvents?: Array<
    | apigee.GoogleCloudApigeeV1ApimServiceExtensionExtensionSupportedEventsItemEnum
    | (string & {})
  >;
};

export type ApimServiceExtensionProps = {
  /**
   * Apigee organization id. Defaults to the GCP project id. Immutable.
   */
  organizationId?: string;
  /**
   * Service extension id (RFC-1034, max 63 characters). If omitted, a
   * unique name is generated. Immutable.
   */
  apimServiceExtensionId?: string;
  /**
   * Load balancer forwarding rule
   * (`projects/{project}/regions/{region}/forwardingRules/{rule}` or
   * global).
   */
  lbForwardingRule: string;
  /**
   * VPC network (`projects/{project}/global/networks/{network}`).
   */
  network: string;
  /**
   * Network configurations for the PSC NEG.
   */
  networkConfigs: ApimNetworkConfig[];
  /**
   * Name of the proxy deployed in the Apigee X instance.
   */
  extensionProcessor: string;
  /**
   * Extensions that make up this service extension. Alchemy prepends a
   * never-matching ownership extension (`alchown`) so `list` / nuke can
   * find the resource — the API has no labels field.
   */
  extensions?: ApimExtension[];
};

export type ApimServiceExtension = Resource<
  "GCP.Apigee.ApimServiceExtension",
  ApimServiceExtensionProps,
  {
    /** Full resource name `organizations/{org}/apimServiceExtensions/{id}`. */
    name: string;
    /** Service extension id. */
    apimServiceExtensionId: string;
    /** Organization id. */
    organizationId: string;
    /** Project id. */
    project: string;
    /** Load balancer forwarding rule. */
    lbForwardingRule: string;
    /** VPC network. */
    network: string;
    /** Network configurations. */
    networkConfigs: ApimNetworkConfig[];
    /** Extension processor proxy name. */
    extensionProcessor: string;
    /** User extensions (Alchemy ownership extension stripped). */
    extensions: ApimExtension[];
    /** Server-reported state. */
    state: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An APIM service extension that routes load-balancer traffic to an
 * existing Apigee X instance.
 *
 * Service extensions have no labels or description. Alchemy stamps
 * ownership as a never-matching `alchown` extension so `list` / nuke
 * can find them. Changing the id or organization replaces the resource.
 *
 * ### Creating a Service Extension
 * **Example:** Route a regional forwarding rule
 * ```typescript
 * const extension = yield* GCP.Apigee.ApimServiceExtension("Edge", {
 *   lbForwardingRule:
 *     "projects/my-project/regions/us-central1/forwardingRules/https",
 *   network: "projects/my-project/global/networks/default",
 *   networkConfigs: [{
 *     region: "us-central1",
 *     subnet: "projects/my-project/regions/us-central1/subnetworks/default",
 *   }],
 *   extensionProcessor: "ext-processor",
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const ApimServiceExtension = Resource<ApimServiceExtension>(
  "GCP.Apigee.ApimServiceExtension",
);

export class ApimServiceExtensionNotResolved extends Data.TaggedError(
  "GCP.Apigee.ApimServiceExtensionNotResolved",
)<{
  name: string;
}> {}

const resourceName = (organizationId: string, extensionId: string) =>
  `${orgParent(organizationId)}/apimServiceExtensions/${extensionId}`;

const toExtension = (
  extension: apigee.GoogleCloudApigeeV1ApimServiceExtensionExtension,
): ApimExtension => ({
  name: extension.name ?? "",
  hostname: extension.hostname ?? "",
  failOpen: extension.failOpen,
  matchCondition: extension.matchCondition,
  supportedEvents: extension.supportedEvents
    ? [...extension.supportedEvents]
    : undefined,
});

const toAttrs = (
  resource: apigee.GoogleCloudApigeeV1ApimServiceExtension,
  project: string,
  organizationId: string,
) => {
  const name = resource.name ?? "";
  return {
    name,
    apimServiceExtensionId: lastSegment(name),
    organizationId,
    project,
    lbForwardingRule: resource.lbForwardingRule ?? "",
    network: resource.network ?? "",
    networkConfigs: (resource.networkConfigs ?? []).map((config) => ({
      region: config.region ?? "",
      subnet: config.subnet ?? "",
    })),
    extensionProcessor: resource.extensionProcessor ?? "",
    extensions: stripOwnershipExtension(resource.extensions).map(toExtension),
    state: resource.state,
    createTime: resource.createTime,
    updateTime: resource.updateTime,
  };
};

const getByName = (name: string) =>
  apigee
    .getOrganizationsApimServiceExtensions({ name })
    .pipe(
      Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

export const ApimServiceExtensionProvider = () =>
  Provider.succeed(ApimServiceExtension, {
    stables: [
      "name",
      "apimServiceExtensionId",
      "organizationId",
      "project",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId =
        olds?.apimServiceExtensionId ?? output?.apimServiceExtensionId;
      const previousOrg = olds?.organizationId ?? output?.organizationId;
      if (
        (previousId !== undefined &&
          news.apimServiceExtensionId !== undefined &&
          news.apimServiceExtensionId !== previousId) ||
        (previousOrg !== undefined &&
          news.organizationId !== undefined &&
          news.organizationId !== previousOrg)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const organizationId =
        olds?.organizationId ??
        output?.organizationId ??
        (yield* resolveOrgId(env.project));
      const extensionId = yield* toPhysicalId(
        id,
        olds?.apimServiceExtensionId,
        output?.apimServiceExtensionId,
        MAX_NAME_LENGTH,
      );
      const name = output?.name ?? resourceName(organizationId, extensionId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, organizationId);
      const labels = parseOwnershipExtension(existing.extensions);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const organizationId = yield* resolveOrgId(env.project);
        return yield* apigee.listOrganizationsApimServiceExtensions
          .pages({
            parent: orgParent(organizationId),
            pageSize: 100,
          })
          .pipe(
            Stream.flatMap((page) =>
              Stream.fromIterable(page.apimServiceExtensions ?? []),
            ),
            Stream.filter((resource) =>
              hasOwnershipExtension(resource.extensions),
            ),
            Stream.map((resource) =>
              toAttrs(resource, env.project, organizationId),
            ),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
              Effect.succeed([]),
            ),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const organizationId =
        news.organizationId ??
        output?.organizationId ??
        (yield* resolveOrgId(env.project));
      const extensionId = yield* toPhysicalId(
        id,
        news.apimServiceExtensionId,
        output?.apimServiceExtensionId,
        MAX_NAME_LENGTH,
      );
      const name = resourceName(organizationId, extensionId);
      const ownership = yield* createInternalLabels(id);
      const desiredExtensions = withOwnershipExtension(
        ownership,
        news.extensions,
      );
      const body: apigee.GoogleCloudApigeeV1ApimServiceExtension = {
        name: extensionId,
        lbForwardingRule: news.lbForwardingRule,
        network: news.network,
        networkConfigs: news.networkConfigs,
        extensionProcessor: news.extensionProcessor,
        extensions: desiredExtensions,
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        yield* apigee
          .createOrganizationsApimServiceExtensions({
            parent: orgParent(organizationId),
            apimServiceExtensionId: extensionId,
            body,
          })
          .pipe(
            Effect.flatMap((operation) => waitForOperation(operation)),
            Effect.catchTag("Conflict", () => Effect.void),
          );
        current = yield* getByName(name);
      }

      if (current === undefined) {
        return yield* new ApimServiceExtensionNotResolved({ name });
      }

      const needsUpdate =
        (current.lbForwardingRule ?? "") !== news.lbForwardingRule ||
        (current.network ?? "") !== news.network ||
        (current.extensionProcessor ?? "") !== news.extensionProcessor ||
        !sameJson(current.networkConfigs ?? [], news.networkConfigs) ||
        !sameJson(current.extensions ?? [], desiredExtensions);

      if (needsUpdate) {
        const operation = yield* apigee.patchOrganizationsApimServiceExtensions(
          {
            name,
            updateMask:
              "lbForwardingRule,network,networkConfigs,extensionProcessor,extensions",
            body,
          },
        );
        yield* waitForOperation(operation);
        current = (yield* getByName(name)) ?? current;
      }

      return toAttrs(current, env.project, organizationId);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* apigee
        .deleteOrganizationsApimServiceExtensions({ name: output.name })
        .pipe(
          Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
            Effect.succeed(undefined),
          ),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
    }),
  });
