import * as networksecurity from "@distilled.cloud/gcp/networksecurity_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
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
  DEFAULT_LOCATION,
  normalizeLocation,
  parentOf,
  parseResourceName,
  resourceName,
  toId,
  userLabels,
} from "./names.ts";
import { waitForOperation } from "./operations.ts";
import { sameJson } from "./ownership.ts";

const COLLECTION = "serverTlsPolicies";

export type ServerTlsGrpcEndpoint = {
  /** gRPC endpoint URI. Only UDS paths starting with `unix:` are supported. */
  targetUri?: string;
};

export type ServerTlsCertificateProviderInstance = {
  /**
   * Plugin instance name. Set to `google_cloud_private_spiffe` to use
   * Certificate Authority Service.
   */
  pluginInstance?: string;
};

export type ServerTlsCertificateProvider = {
  /** gRPC endpoint used to obtain the certificate and private key. */
  grpcEndpoint?: ServerTlsGrpcEndpoint;
  /** Certificate provider plugin instance loaded by the data plane. */
  certificateProviderInstance?: ServerTlsCertificateProviderInstance;
};

export type ServerTlsValidationCA = ServerTlsCertificateProvider;

export type ServerTlsClientValidationMode =
  | "ALLOW_INVALID_OR_MISSING_CLIENT_CERT"
  | "REJECT_INVALID"
  | (string & {});

export type ServerTlsMtlsPolicy = {
  /**
   * Certificate authorities used to validate the client certificate
   * (Traffic Director). Must be empty for Application Load Balancers.
   */
  clientValidationCa?: ServerTlsValidationCA[];
  /**
   * Certificate Manager TrustConfig used for chain validation. Allowed
   * only with Application Load Balancers.
   */
  clientValidationTrustConfig?: string;
  /**
   * How the load balancer handles a missing or invalid client
   * certificate. Required for Application Load Balancers; must be empty
   * for Traffic Director.
   */
  clientValidationMode?: ServerTlsClientValidationMode;
};

export type ServerTlsPolicyProps = {
  /**
   * ServerTlsPolicy id (the `{serverTlsPolicy}` segment of
   * `projects/{project}/locations/{location}/serverTlsPolicies/{serverTlsPolicy}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Must be 1-63 characters, letters, numbers, hyphens,
   * and underscores, and must not start with a number. Immutable —
   * changing it replaces the policy.
   */
  serverTlsPolicyId?: string;
  /**
   * Location (`global`, `us-central1`, …). Immutable — changing it
   * replaces the policy. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default "global"
   */
  location?: string;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * When true, the server also accepts plaintext connections. Must be
   * false for Application Load Balancer policies. Defaults to false.
   * @default false
   */
  allowOpen?: boolean;
  /**
   * Server identity (public/private keys). Optional for Traffic Director.
   * Must be empty for Application Load Balancers. Cannot be combined
   * with `allowOpen`.
   */
  serverCertificate?: ServerTlsCertificateProvider;
  /**
   * Peer validation for mTLS. Required for Application Load Balancers;
   * optional for Traffic Director. When omitted, client certificates are
   * not requested (plain TLS).
   */
  mtlsPolicy?: ServerTlsMtlsPolicy;
};

export type ServerTlsPolicy = Resource<
  "GCP.NetworkSecurity.ServerTlsPolicy",
  ServerTlsPolicyProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/serverTlsPolicies/{serverTlsPolicy}`. */
    name: string;
    /** ServerTlsPolicy id (last path segment). */
    serverTlsPolicyId: string;
    /** Project id. */
    project: string;
    /** Location id (`global`, `us-central1`, …). */
    location: string;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Whether plaintext connections are allowed. */
    allowOpen: boolean;
    /** Server certificate provider, if configured. */
    serverCertificate: ServerTlsCertificateProvider | undefined;
    /** mTLS policy, if configured. */
    mtlsPolicy: ServerTlsMtlsPolicy | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Network Security ServerTlsPolicy — how a server authenticates
 * incoming requests. Attach it to a TargetHttpsProxy or EndpointPolicy;
 * the policy itself does not serve traffic.
 *
 * Changing `serverTlsPolicyId` or `location` replaces the policy.
 * Application Load Balancer policies (`mtlsPolicy.clientValidationMode`
 * set) cannot be updated in place — any other change replaces them.
 * Traffic Director policies update description, labels, `allowOpen`,
 * `serverCertificate`, and `mtlsPolicy` in place.
 *
 * ### Creating a ServerTlsPolicy
 * **Example:** Application Load Balancer mTLS
 * ```typescript
 * const policy = yield* GCP.NetworkSecurity.ServerTlsPolicy("FrontendTls", {
 *   description: "alb mtls",
 *   mtlsPolicy: {
 *     clientValidationMode: "ALLOW_INVALID_OR_MISSING_CLIENT_CERT",
 *   },
 * });
 * ```
 *
 * **Example:** Named policy with labels
 * ```typescript
 * const policy = yield* GCP.NetworkSecurity.ServerTlsPolicy("FrontendTls", {
 *   serverTlsPolicyId: "app-frontend-tls",
 *   location: "global",
 *   description: "prod frontend",
 *   labels: { env: "prod" },
 *   mtlsPolicy: {
 *     clientValidationMode: "ALLOW_INVALID_OR_MISSING_CLIENT_CERT",
 *   },
 * });
 * ```
 *
 * ### Updating a ServerTlsPolicy
 * **Example:** Description and labels
 * ```typescript
 * const policy = yield* GCP.NetworkSecurity.ServerTlsPolicy("FrontendTls", {
 *   serverTlsPolicyId: "app-frontend-tls",
 *   location: "global",
 *   description: "prod frontend v2",
 *   labels: { env: "prod", role: "tls" },
 *   mtlsPolicy: {
 *     clientValidationMode: "ALLOW_INVALID_OR_MISSING_CLIENT_CERT",
 *   },
 * });
 * ```
 *
 * @resource
 * @category NetworkSecurity
 */
export const ServerTlsPolicy = Resource<ServerTlsPolicy>(
  "GCP.NetworkSecurity.ServerTlsPolicy",
);

export class ServerTlsPolicyNotResolved extends Data.TaggedError(
  "GCP.NetworkSecurity.ServerTlsPolicyNotResolved",
)<{
  name: string;
}> {}

export class ServerTlsPolicyStillExists extends Data.TaggedError(
  "GCP.NetworkSecurity.ServerTlsPolicyStillExists",
)<{
  name: string;
}> {}

const toCertificateProvider = (
  value:
    | networksecurity.GoogleCloudNetworksecurityV1CertificateProvider
    | ServerTlsCertificateProvider
    | undefined,
): ServerTlsCertificateProvider | undefined => {
  if (value === undefined) return undefined;
  const grpcEndpoint = value.grpcEndpoint
    ? { targetUri: value.grpcEndpoint.targetUri }
    : undefined;
  const certificateProviderInstance = value.certificateProviderInstance
    ? {
        pluginInstance: value.certificateProviderInstance.pluginInstance,
      }
    : undefined;
  if (grpcEndpoint === undefined && certificateProviderInstance === undefined) {
    return undefined;
  }
  return { grpcEndpoint, certificateProviderInstance };
};

const toMtlsPolicy = (
  value: networksecurity.MTLSPolicy | ServerTlsMtlsPolicy | undefined,
): ServerTlsMtlsPolicy | undefined => {
  if (value === undefined) return undefined;
  return {
    clientValidationCa: (value.clientValidationCa ?? [])
      .map((entry) => toCertificateProvider(entry))
      .filter(
        (entry): entry is ServerTlsCertificateProvider => entry !== undefined,
      ),
    clientValidationTrustConfig: value.clientValidationTrustConfig,
    clientValidationMode: value.clientValidationMode,
  };
};

const toAttrs = (policy: networksecurity.ServerTlsPolicy, project: string) => {
  const name = policy.name ?? "";
  const parsed = parseResourceName(name, COLLECTION);
  return {
    name,
    serverTlsPolicyId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || DEFAULT_LOCATION,
    description: policy.description,
    labels: userLabels(policy.labels),
    allowOpen: policy.allowOpen === true,
    serverCertificate: toCertificateProvider(policy.serverCertificate),
    mtlsPolicy: toMtlsPolicy(policy.mtlsPolicy),
    createTime: policy.createTime,
    updateTime: policy.updateTime,
  };
};

const getByName = (name: string) =>
  networksecurity
    .getProjectsLocationsServerTlsPolicies({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((policy) =>
      policy
        ? Effect.succeed(policy)
        : Effect.fail(new ServerTlsPolicyNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.NetworkSecurity.ServerTlsPolicyNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((policy) =>
      policy === undefined
        ? Effect.void
        : Effect.fail(new ServerTlsPolicyStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.NetworkSecurity.ServerTlsPolicyStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const listOwned = (project: string) =>
  networksecurity.listProjectsLocationsServerTlsPolicies
    .pages({
      parent: parentOf(project, "-"),
      pageSize: 1000,
      returnPartialSuccess: true,
    })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.serverTlsPolicies ?? []),
      ),
      Stream.filter((policy) =>
        Object.keys(policy.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ),
      Stream.map((policy) => toAttrs(policy, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const toCreateBody = (
  news: ServerTlsPolicyProps,
  desiredLabels: Record<string, string>,
): networksecurity.ServerTlsPolicy => ({
  description: news.description,
  labels: desiredLabels,
  allowOpen: news.allowOpen === true ? true : false,
  serverCertificate: toCertificateProvider(news.serverCertificate),
  mtlsPolicy: toMtlsPolicy(news.mtlsPolicy),
});

export const ServerTlsPolicyProvider = () =>
  Provider.succeed(ServerTlsPolicy, {
    stables: ["name", "serverTlsPolicyId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.serverTlsPolicyId ?? output?.serverTlsPolicyId;
      const nextId = news.serverTlsPolicyId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
      );
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation
      ) {
        return { action: "replace" as const };
      }
      const alb =
        (news.mtlsPolicy?.clientValidationMode ??
          olds?.mtlsPolicy?.clientValidationMode ??
          output?.mtlsPolicy?.clientValidationMode ??
          "") !== "";
      if (!alb) return undefined;
      const descriptionChanged =
        (news.description ?? "") !==
        (olds?.description ?? output?.description ?? "");
      const labelsChanged = !sameJson(
        toLabels(news.labels ?? {}),
        toLabels(olds?.labels ?? output?.labels ?? {}),
      );
      const allowOpenChanged =
        (news.allowOpen === true) !==
        (olds?.allowOpen === true || output?.allowOpen === true);
      const mtlsChanged = !sameJson(
        toMtlsPolicy(news.mtlsPolicy),
        toMtlsPolicy(olds?.mtlsPolicy ?? output?.mtlsPolicy),
      );
      const certificateChanged = !sameJson(
        toCertificateProvider(news.serverCertificate),
        toCertificateProvider(
          olds?.serverCertificate ?? output?.serverCertificate,
        ),
      );
      if (
        descriptionChanged ||
        labelsChanged ||
        allowOpenChanged ||
        mtlsChanged ||
        certificateChanged
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const serverTlsPolicyId = yield* toId(
        id,
        olds?.serverTlsPolicyId,
        output?.serverTlsPolicyId,
        "servertls",
      );
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name =
        output?.name ??
        resourceName(env.project, location, COLLECTION, serverTlsPolicyId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* listOwned(env.project);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const serverTlsPolicyId = yield* toId(
        id,
        news.serverTlsPolicyId,
        output?.serverTlsPolicyId,
        "servertls",
      );
      const location = normalizeLocation(news.location ?? output?.location);
      const name = resourceName(
        env.project,
        location,
        COLLECTION,
        serverTlsPolicyId,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const allowOpen = news.allowOpen === true;
      const desiredCertificate = toCertificateProvider(news.serverCertificate);
      const desiredMtls = toMtlsPolicy(news.mtlsPolicy);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* networksecurity
          .createProjectsLocationsServerTlsPolicies({
            parent: parentOf(env.project, location),
            serverTlsPolicyId,
            body: toCreateBody(news, desiredLabels),
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
        current = yield* waitUntilExists(name);
      }

      if (current === undefined) {
        return yield* new ServerTlsPolicyNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const allowOpenChanged = (current.allowOpen === true) !== allowOpen;
      const certificateChanged = !sameJson(
        toCertificateProvider(current.serverCertificate),
        desiredCertificate,
      );
      const mtlsChanged = !sameJson(
        toMtlsPolicy(current.mtlsPolicy),
        desiredMtls,
      );

      if (
        labelsChanged ||
        descriptionChanged ||
        allowOpenChanged ||
        certificateChanged ||
        mtlsChanged
      ) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          descriptionChanged ? "description" : undefined,
          allowOpenChanged ? "allowOpen" : undefined,
          certificateChanged ? "serverCertificate" : undefined,
          mtlsChanged ? "mtlsPolicy" : undefined,
        ].filter((field): field is string => field !== undefined);
        const operation =
          yield* networksecurity.patchProjectsLocationsServerTlsPolicies({
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: {
              name: current.name ?? name,
              labels: desiredLabels,
              description: news.description,
              allowOpen,
              serverCertificate: desiredCertificate,
              mtlsPolicy: desiredMtls,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(current.name ?? name);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networksecurity
        .deleteProjectsLocationsServerTlsPolicies({ name: output.name })
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
      yield* waitUntilGone(output.name);
    }),
  });
