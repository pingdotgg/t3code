import * as networkservices from "@distilled.cloud/gcp/networkservices_v1";
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
  changedFields,
  collectPages,
  hasAlchemyLabelKeys,
  normalizeLocation,
  parentOf,
  parseName,
  resourceName,
  rfc1035,
  sameJson,
  sameStringList,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilGone,
  waitUntilPresent,
} from "./internal.ts";

const COLLECTION = "authzExtensions";
const DEFAULT_SCHEME = "INTERNAL_MANAGED";
const DEFAULT_TIMEOUT = "0.1s";

export type AuthzExtensionLoadBalancingScheme =
  | networkservices.AuthzExtensionLoadBalancingSchemeEnum
  | (string & {});

export type AuthzExtensionWireFormat =
  | networkservices.AuthzExtensionWireFormatEnum
  | (string & {});

export type AuthzExtensionProps = {
  /**
   * AuthzExtension id (the `{authzExtension}` segment of
   * `projects/{project}/locations/{location}/authzExtensions/{authzExtension}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must be 1-63 characters and not start with a number.
   * Immutable — changing it replaces the extension.
   */
  authzExtensionId?: string;
  /**
   * Location (`us-central1`, `global`, …). Immutable — changing it
   * replaces the extension. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Fully-qualified backend service URL that runs the callout, e.g.
   * `https://www.googleapis.com/compute/v1/projects/{project}/regions/{region}/backendServices/{backendService}`.
   */
  service: string;
  /**
   * Timeout for each message on the stream. Must be between 10ms and
   * 10000ms (for example `0.1s` or `1000ms`).
   * @default "0.1s"
   */
  timeout?: string;
  /**
   * Load balancing scheme shared by referenced backend services and
   * forwarding rules. Immutable — changing it replaces the extension.
   * @default "INTERNAL_MANAGED"
   */
  loadBalancingScheme?: AuthzExtensionLoadBalancingScheme;
  /**
   * `:authority` header sent from Envoy to the extension service.
   * Required when `service` points at a backend service or wasm plugin.
   */
  authority?: string;
  /**
   * Continue request processing if the callout fails or times out.
   * @default false
   */
  failOpen?: boolean;
  /**
   * Metadata included under `com.google.authz_extension.` in the
   * `ProcessingRequest`. Values may use `{forwarding_rule_id}`.
   */
  metadata?: Record<string, unknown>;
  /**
   * HTTP headers forwarded to the extension. Omitted sends every header.
   */
  forwardHeaders?: string[];
  /**
   * Envoy attributes forwarded to the extension. Omitted sends none.
   */
  forwardAttributes?: string[];
  /**
   * Callout wire format. Regional resources default to `EXT_PROC_GRPC`.
   * Global resources always use `EXT_PROC_GRPC`.
   */
  wireFormat?: AuthzExtensionWireFormat;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type AuthzExtension = Resource<
  "GCP.NetworkServices.AuthzExtension",
  AuthzExtensionProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/authzExtensions/{authzExtension}`. */
    name: string;
    /** AuthzExtension id (last path segment). */
    authzExtensionId: string;
    /** Project id. */
    project: string;
    /** Location id (`us-central1`, `global`, …). */
    location: string;
    /** Backend service URL that runs the callout. */
    service: string | undefined;
    /** Per-message timeout. */
    timeout: string | undefined;
    /** Load balancing scheme. */
    loadBalancingScheme: string | undefined;
    /** `:authority` header, if set. */
    authority: string | undefined;
    /** Whether the proxy continues on callout failure. */
    failOpen: boolean;
    /** Callout metadata. */
    metadata: Record<string, unknown> | undefined;
    /** Forwarded HTTP headers. */
    forwardHeaders: string[];
    /** Forwarded Envoy attributes. */
    forwardAttributes: string[];
    /** Callout wire format, if set. */
    wireFormat: string | undefined;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Network Services AuthzExtension — forwards requests to a callout
 * backend that makes an authorization decision for a load balancer.
 *
 * Changing `authzExtensionId`, `location`, or `loadBalancingScheme`
 * replaces the extension. Description, labels, service, timeout,
 * authority, fail-open, metadata, headers, and wire format update in
 * place.
 *
 * ### Creating an AuthzExtension
 * **Example:** Regional callout
 * ```typescript
 * const ext = yield* GCP.NetworkServices.AuthzExtension("Authz", {
 *   service: backend.selfLink,
 *   authority: "authz.example.com",
 *   timeout: "0.1s",
 *   loadBalancingScheme: "INTERNAL_MANAGED",
 * });
 * ```
 *
 * **Example:** Named extension with labels
 * ```typescript
 * const ext = yield* GCP.NetworkServices.AuthzExtension("Authz", {
 *   authzExtensionId: "app-authz",
 *   location: "us-central1",
 *   description: "prod authz",
 *   labels: { env: "prod" },
 *   service: backend.selfLink,
 *   authority: "authz.example.com",
 *   timeout: "0.2s",
 *   failOpen: true,
 * });
 * ```
 *
 * @resource
 * @category NetworkServices
 */
export const AuthzExtension = Resource<AuthzExtension>(
  "GCP.NetworkServices.AuthzExtension",
);

const toAttrs = (
  extension: networkservices.AuthzExtension,
  project: string,
  region: string,
) => {
  const name = extension.name ?? "";
  const parsed = parseName(name, COLLECTION, region);
  return {
    name,
    authzExtensionId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || region,
    service: extension.service,
    timeout: extension.timeout,
    loadBalancingScheme: extension.loadBalancingScheme,
    authority: extension.authority,
    failOpen: extension.failOpen === true,
    metadata: extension.metadata,
    forwardHeaders: extension.forwardHeaders ?? [],
    forwardAttributes: extension.forwardAttributes ?? [],
    wireFormat: extension.wireFormat,
    description: extension.description,
    labels: userLabels(extension.labels),
    createTime: extension.createTime,
    updateTime: extension.updateTime,
  };
};

const getByName = (name: string) =>
  networkservices
    .getProjectsLocationsAuthzExtensions({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const AuthzExtensionProvider = () =>
  Provider.succeed(AuthzExtension, {
    stables: ["name", "authzExtensionId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId = olds?.authzExtensionId ?? output?.authzExtensionId;
      const nextId = news.authzExtensionId
        ? rfc1035(news.authzExtensionId, "authz-extension")
        : previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      const previousScheme =
        olds?.loadBalancingScheme ??
        output?.loadBalancingScheme ??
        DEFAULT_SCHEME;
      const nextScheme = news.loadBalancingScheme ?? previousScheme;
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        previousScheme !== nextScheme
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const authzExtensionId = yield* toPhysicalId(
        id,
        olds?.authzExtensionId,
        output?.authzExtensionId,
        "authz-extension",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, COLLECTION, authzExtensionId);
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
        const items = yield* collectPages(
          networkservices.listProjectsLocationsAuthzExtensions.pages({
            parent: parentOf(env.project, "-"),
            pageSize: 1000,
          }),
          (page) => page.authzExtensions,
        );
        return items
          .filter((item) => hasAlchemyLabelKeys(item.labels))
          .map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const authzExtensionId = yield* toPhysicalId(
        id,
        news.authzExtensionId,
        output?.authzExtensionId,
        "authz-extension",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(
        env.project,
        location,
        COLLECTION,
        authzExtensionId,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const loadBalancingScheme = news.loadBalancingScheme ?? DEFAULT_SCHEME;
      const timeout = news.timeout ?? DEFAULT_TIMEOUT;
      const failOpen = news.failOpen === true;
      const desiredHeaders = news.forwardHeaders ?? [];
      const desiredAttributes = news.forwardAttributes ?? [];

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networkservices
          .createProjectsLocationsAuthzExtensions({
            parent: parentOf(env.project, location),
            authzExtensionId,
            body: {
              labels: desiredLabels,
              description: news.description,
              service: news.service,
              timeout,
              loadBalancingScheme,
              authority: news.authority,
              failOpen,
              metadata: news.metadata,
              forwardHeaders: desiredHeaders,
              forwardAttributes: desiredAttributes,
              wireFormat: news.wireFormat,
            },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 5,
              schedule: Schedule.spaced("2 seconds"),
            }),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilPresent(getByName(name), name);
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const serviceChanged = (current.service ?? "") !== (news.service ?? "");
      const timeoutChanged = (current.timeout ?? "") !== timeout;
      const authorityChanged =
        (current.authority ?? "") !== (news.authority ?? "");
      const failOpenChanged = (current.failOpen === true) !== failOpen;
      const metadataChanged = !sameJson(current.metadata, news.metadata);
      const headersChanged = !sameStringList(
        current.forwardHeaders,
        desiredHeaders,
      );
      const attributesChanged = !sameStringList(
        current.forwardAttributes,
        desiredAttributes,
      );
      const wireChanged =
        (current.wireFormat ?? "") !== (news.wireFormat ?? "");

      const updateMask = changedFields([
        ["labels", labelsChanged],
        ["description", descriptionChanged],
        ["service", serviceChanged],
        ["timeout", timeoutChanged],
        ["authority", authorityChanged],
        ["failOpen", failOpenChanged],
        ["metadata", metadataChanged],
        ["forwardHeaders", headersChanged],
        ["forwardAttributes", attributesChanged],
        ["wireFormat", wireChanged],
      ]);

      if (updateMask.length > 0) {
        const operation =
          yield* networkservices.patchProjectsLocationsAuthzExtensions({
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: {
              name: current.name ?? name,
              labels: desiredLabels,
              description: news.description,
              service: news.service,
              timeout,
              loadBalancingScheme,
              authority: news.authority,
              failOpen,
              metadata: news.metadata,
              forwardHeaders: desiredHeaders,
              forwardAttributes: desiredAttributes,
              wireFormat: news.wireFormat,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilPresent(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networkservices
        .deleteProjectsLocationsAuthzExtensions({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
