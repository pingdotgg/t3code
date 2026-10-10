import * as networksecurity from "@distilled.cloud/gcp/networksecurity_v1";
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
  DEFAULT_GLOBAL,
  changedFields,
  collectPages,
  hasAlchemyLabelKeys,
  normalizeLocation,
  parentOf,
  parseName,
  rfc1035,
  sameJson,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilGone,
  waitUntilPresent,
} from "./internal.ts";

const COLLECTION = "clientTlsPolicies";

export type GrpcEndpoint = {
  /** gRPC UDS target URI. Must start with `unix:`. */
  targetUri?: string;
};

export type CertificateProviderInstance = {
  /**
   * Plugin instance name. Use `google_cloud_private_spiffe` for
   * Certificate Authority Service.
   */
  pluginInstance?: string;
};

export type ValidationCA = {
  /** gRPC endpoint used to obtain the CA certificate. */
  grpcEndpoint?: GrpcEndpoint;
  /** Certificate provider instance loaded by the data plane. */
  certificateProviderInstance?: CertificateProviderInstance;
};

export type CertificateProvider = {
  /** gRPC endpoint used to obtain the cert and private key. */
  grpcEndpoint?: GrpcEndpoint;
  /** Certificate provider instance loaded by the data plane. */
  certificateProviderInstance?: CertificateProviderInstance;
};

export type ClientTlsPolicyProps = {
  /**
   * ClientTlsPolicy id (the `{clientTlsPolicy}` segment of
   * `projects/{project}/locations/{location}/clientTlsPolicies/{clientTlsPolicy}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must be 1-63 characters and not start with a number.
   * Immutable — changing it replaces the policy.
   */
  clientTlsPolicyId?: string;
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
   * Server Name Indication presented during the TLS handshake
   * (e.g. `secure.example.com`).
   */
  sni?: string;
  /**
   * Mechanism used to obtain CA certificates that validate the server
   * certificate. Empty means the client does not validate the server.
   */
  serverValidationCa?: ValidationCA[];
  /**
   * Mechanism used to provision client identity for mTLS. Presence of
   * this field enables mTLS.
   */
  clientCertificate?: CertificateProvider;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type ClientTlsPolicy = Resource<
  "GCP.NetworkSecurity.ClientTlsPolicy",
  ClientTlsPolicyProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/clientTlsPolicies/{clientTlsPolicy}`. */
    name: string;
    /** ClientTlsPolicy id (last path segment). */
    clientTlsPolicyId: string;
    /** Project id. */
    project: string;
    /** Location id (`global`, `us-central1`, …). */
    location: string;
    /** User-provided description. */
    description: string | undefined;
    /** SNI string presented to the server, if set. */
    sni: string | undefined;
    /** Server-validation CAs currently configured. */
    serverValidationCa: ValidationCA[];
    /** Client certificate provider used for mTLS, if set. */
    clientCertificate: CertificateProvider | undefined;
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
 * A Network Security ClientTlsPolicy — how a client authenticates
 * connections to backends. The policy has no effect until it is
 * attached to a backend service.
 *
 * Changing `clientTlsPolicyId` or `location` replaces the policy.
 * Description, labels, SNI, server-validation CAs, and the client
 * certificate provider update in place.
 *
 * ### Creating a ClientTlsPolicy
 * **Example:** Generated name
 * ```typescript
 * const policy = yield* GCP.NetworkSecurity.ClientTlsPolicy("BackendTls", {
 *   sni: "backend.example.com",
 * });
 * ```
 *
 * **Example:** Named policy with labels
 * ```typescript
 * const policy = yield* GCP.NetworkSecurity.ClientTlsPolicy("BackendTls", {
 *   clientTlsPolicyId: "app-backend-tls",
 *   description: "prod backends",
 *   labels: { env: "prod" },
 *   sni: "backend.example.com",
 * });
 * ```
 *
 * ### mTLS
 * **Example:** Private SPIFFE identity plus CA validation
 * ```typescript
 * const policy = yield* GCP.NetworkSecurity.ClientTlsPolicy("Mtls", {
 *   sni: "secure.example.com",
 *   clientCertificate: {
 *     certificateProviderInstance: {
 *       pluginInstance: "google_cloud_private_spiffe",
 *     },
 *   },
 *   serverValidationCa: [
 *     {
 *       certificateProviderInstance: {
 *         pluginInstance: "google_cloud_private_spiffe",
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 * @category NetworkSecurity
 */
export const ClientTlsPolicy = Resource<ClientTlsPolicy>(
  "GCP.NetworkSecurity.ClientTlsPolicy",
);

const resourceName = (
  project: string,
  location: string,
  clientTlsPolicyId: string,
) =>
  `projects/${project}/locations/${location}/clientTlsPolicies/${clientTlsPolicyId}`;

const toCa = (
  ca: ValidationCA | networksecurity.ValidationCA,
): ValidationCA => ({
  grpcEndpoint: ca.grpcEndpoint
    ? { targetUri: ca.grpcEndpoint.targetUri }
    : undefined,
  certificateProviderInstance: ca.certificateProviderInstance
    ? { pluginInstance: ca.certificateProviderInstance.pluginInstance }
    : undefined,
});

const toProvider = (
  provider:
    | CertificateProvider
    | networksecurity.GoogleCloudNetworksecurityV1CertificateProvider
    | undefined,
): CertificateProvider | undefined => {
  if (provider === undefined) return undefined;
  const grpcEndpoint = provider.grpcEndpoint
    ? { targetUri: provider.grpcEndpoint.targetUri }
    : undefined;
  const certificateProviderInstance = provider.certificateProviderInstance
    ? { pluginInstance: provider.certificateProviderInstance.pluginInstance }
    : undefined;
  if (grpcEndpoint === undefined && certificateProviderInstance === undefined) {
    return undefined;
  }
  return { grpcEndpoint, certificateProviderInstance };
};

const toAttrs = (policy: networksecurity.ClientTlsPolicy, project: string) => {
  const name = policy.name ?? "";
  const parsed = parseName(name, COLLECTION, DEFAULT_GLOBAL);
  return {
    name,
    clientTlsPolicyId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || DEFAULT_GLOBAL,
    description: policy.description,
    sni: policy.sni,
    serverValidationCa: (policy.serverValidationCa ?? []).map(toCa),
    clientCertificate: toProvider(policy.clientCertificate),
    labels: userLabels(policy.labels),
    createTime: policy.createTime,
    updateTime: policy.updateTime,
  };
};

const getByName = (name: string) =>
  networksecurity
    .getProjectsLocationsClientTlsPolicies({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const ClientTlsPolicyProvider = () =>
  Provider.succeed(ClientTlsPolicy, {
    stables: ["name", "clientTlsPolicyId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.clientTlsPolicyId ?? output?.clientTlsPolicyId;
      const nextId = news.clientTlsPolicyId
        ? rfc1035(news.clientTlsPolicyId, "client-tls-policy")
        : previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const clientTlsPolicyId = yield* toPhysicalId(
        id,
        olds?.clientTlsPolicyId,
        output?.clientTlsPolicyId,
        "client-tls-policy",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const name =
        output?.name ?? resourceName(env.project, location, clientTlsPolicyId);
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
        const items = yield* collectPages(
          networksecurity.listProjectsLocationsClientTlsPolicies.pages({
            parent: parentOf(env.project, "-"),
            pageSize: 1000,
          }),
          (page) => page.clientTlsPolicies,
        );
        return items
          .filter((item) => hasAlchemyLabelKeys(item.labels))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const clientTlsPolicyId = yield* toPhysicalId(
        id,
        news.clientTlsPolicyId,
        output?.clientTlsPolicyId,
        "client-tls-policy",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const name = resourceName(env.project, location, clientTlsPolicyId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredCa = (news.serverValidationCa ?? []).map(toCa);
      const desiredClient = toProvider(news.clientCertificate);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networksecurity
          .createProjectsLocationsClientTlsPolicies({
            parent: parentOf(env.project, location),
            clientTlsPolicyId,
            body: {
              description: news.description,
              labels: desiredLabels,
              sni: news.sni,
              serverValidationCa: desiredCa,
              clientCertificate: desiredClient,
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
      const sniChanged = (current.sni ?? "") !== (news.sni ?? "");
      const caChanged = !sameJson(
        (current.serverValidationCa ?? []).map(toCa),
        desiredCa,
      );
      const clientChanged = !sameJson(
        toProvider(current.clientCertificate),
        desiredClient,
      );

      const updateMask = changedFields([
        ["labels", labelsChanged],
        ["description", descriptionChanged],
        ["sni", sniChanged],
        ["serverValidationCa", caChanged],
        ["clientCertificate", clientChanged],
      ]);

      if (updateMask.length > 0) {
        const operation =
          yield* networksecurity.patchProjectsLocationsClientTlsPolicies({
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: {
              name: current.name ?? name,
              labels: desiredLabels,
              description: news.description,
              sni: news.sni,
              serverValidationCa: desiredCa,
              clientCertificate: desiredClient,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilPresent(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networksecurity
        .deleteProjectsLocationsClientTlsPolicies({ name: output.name })
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
