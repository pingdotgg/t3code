import * as dns from "@distilled.cloud/gcp/dns_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  ALCHEMY_LABEL_PREFIX,
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const MAX_NAME_LENGTH = 63;

export type ResponsePolicyProps = {
  /**
   * User-assigned response policy name, unique within the project. If
   * omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Must be 1-63 characters, begin with a letter, end
   * with a letter or digit, and contain only lowercase letters, digits,
   * or dashes. Immutable — changing it replaces the response policy.
   */
  responsePolicyName?: string;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * VPC networks this response policy applies to. Each value may be a
   * network name, a `projects/.../global/networks/...` path, or a full
   * compute URL. A network may belong to at most one response policy.
   * Updates in place.
   */
  networks?: string[];
  /**
   * GKE clusters this response policy applies to, as
   * `projects/{project}/locations/{location}/clusters/{cluster}`.
   * Updates in place.
   */
  gkeClusters?: string[];
};

export type ResponsePolicy = Resource<
  "GCP.DNS.ResponsePolicy",
  ResponsePolicyProps,
  {
    /** User-assigned response policy name. */
    responsePolicyName: string;
    /** Project id. */
    project: string;
    /** Server-assigned numeric id. */
    id: string | undefined;
    /** User description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** VPC network URLs bound to this response policy. */
    networks: ReadonlyArray<string>;
    /** GKE cluster resource names bound to this response policy. */
    gkeClusters: ReadonlyArray<string>;
    /** Server-reported kind (`dns#responsePolicy`). */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud DNS response policy applied to one or more VPC networks.
 *
 * Response policies override DNS answers for selected names (via
 * response policy rules) for VMs in bound networks. Name is identity —
 * changing it replaces the policy. Description, labels, and the
 * network / GKE cluster lists update in place.
 *
 * ### Creating a Response Policy
 * **Example:** Generated name bound to a VPC
 * ```typescript
 * const vpc = yield* GCP.Compute.Network("Vpc", {
 *   autoCreateSubnetworks: false,
 * });
 * const policy = yield* GCP.DNS.ResponsePolicy("Overrides", {
 *   networks: [vpc.networkName],
 * });
 * ```
 *
 * **Example:** Explicit name, description, and labels
 * ```typescript
 * const policy = yield* GCP.DNS.ResponsePolicy("Overrides", {
 *   responsePolicyName: "app-overrides",
 *   description: "split-horizon answers",
 *   labels: { env: "prod" },
 *   networks: ["app-vpc"],
 * });
 * ```
 *
 * @resource
 * @category DNS
 */
export const ResponsePolicy = Resource<ResponsePolicy>(
  "GCP.DNS.ResponsePolicy",
);

export class ResponsePolicyNotResolved extends Data.TaggedError(
  "GCP.DNS.ResponsePolicyNotResolved",
)<{
  responsePolicyName: string;
}> {}

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const toNetworkUrl = (project: string, network: string) => {
  if (network.startsWith("https://") || network.startsWith("http://")) {
    return network;
  }
  if (network.includes("/")) {
    const path = network.replace(/^\//, "");
    return path.startsWith("compute/")
      ? `https://www.googleapis.com/${path}`
      : `https://www.googleapis.com/compute/v1/${path}`;
  }
  return `https://www.googleapis.com/compute/v1/projects/${project}/global/networks/${network}`;
};

const desiredNetworks = (project: string, networks: string[] | undefined) =>
  [
    ...new Set(
      (networks ?? []).map((network) => toNetworkUrl(project, network)),
    ),
  ].sort((left, right) => lastSegment(left).localeCompare(lastSegment(right)));

const observedNetworks = (policy: dns.ResponsePolicy) =>
  (policy.networks ?? [])
    .map((network) => network.networkUrl ?? "")
    .filter((url) => url.length > 0)
    .sort((left, right) => lastSegment(left).localeCompare(lastSegment(right)));

const sameNetworks = (left: string[], right: string[]) =>
  left.length === right.length &&
  left.every(
    (url, index) => lastSegment(url) === lastSegment(right[index] ?? ""),
  );

const desiredClusters = (clusters: string[] | undefined) =>
  [...new Set(clusters ?? [])].sort();

const observedClusters = (policy: dns.ResponsePolicy) =>
  (policy.gkeClusters ?? [])
    .map((cluster) => cluster.gkeClusterName ?? "")
    .filter((name) => name.length > 0)
    .sort();

const sameList = (left: string[], right: string[]) =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const toResponsePolicyName = (
  id: string,
  name: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_NAME_LENGTH,
      lowercase: true,
    });
    const rfc = generated
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/^[^a-z]+/, "r")
      .slice(0, MAX_NAME_LENGTH)
      .replace(/-+$/g, "");
    return rfc.length > 0 ? rfc : "r";
  });

const toAttrs = (policy: dns.ResponsePolicy, project: string) => ({
  responsePolicyName: policy.responsePolicyName ?? "",
  project,
  id: policy.id,
  description:
    policy.description && policy.description.length > 0
      ? policy.description
      : undefined,
  labels: userLabels(policy.labels),
  networks: observedNetworks(policy),
  gkeClusters: observedClusters(policy),
  kind: policy.kind,
});

const getByName = (project: string, responsePolicyName: string) =>
  dns
    .getResponsePolicies({ project, responsePolicy: responsePolicyName })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listRules = (project: string, responsePolicyName: string) =>
  Effect.gen(function* () {
    const found: dns.ResponsePolicyRule[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const response = yield* dns.listResponsePolicyRules({
        project,
        responsePolicy: responsePolicyName,
        maxResults: 1000,
        pageToken,
      });
      found.push(...(response.responsePolicyRules ?? []));
      pageToken = response.nextPageToken;
      if (pageToken === undefined || pageToken === "") break;
    }
    return found;
  }).pipe(
    Effect.catchTag("NotFound", () =>
      Effect.succeed([] as dns.ResponsePolicyRule[]),
    ),
  );

const emptyRules = (project: string, responsePolicyName: string) =>
  Effect.gen(function* () {
    const rules = yield* listRules(project, responsePolicyName);
    yield* Effect.forEach(
      rules,
      (rule) =>
        rule.ruleName
          ? dns
              .deleteResponsePolicyRules({
                project,
                responsePolicy: responsePolicyName,
                responsePolicyRule: rule.ruleName,
              })
              .pipe(Effect.catchTag("NotFound", () => Effect.void))
          : Effect.void,
      { concurrency: 4 },
    );
  });

export const ResponsePolicyProvider = () =>
  Provider.succeed(ResponsePolicy, {
    stables: ["responsePolicyName", "project", "id"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName =
        olds?.responsePolicyName ?? output?.responsePolicyName;
      const nextName = news.responsePolicyName ?? previousName;
      if (
        previousName === undefined ||
        nextName === undefined ||
        nextName === previousName
      ) {
        return undefined;
      }
      // A VPC may belong to only one response policy, so the old policy
      // must be deleted before the new one can attach to the same
      // network.
      return { action: "replace" as const, deleteFirst: true };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const responsePolicyName = yield* toResponsePolicyName(
        id,
        olds?.responsePolicyName,
        output?.responsePolicyName,
      );
      const existing = yield* getByName(env.project, responsePolicyName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const found: ReturnType<typeof toAttrs>[] = [];
        let pageToken: string | undefined;
        for (let page = 0; page < 10; page++) {
          const response = yield* dns.listResponsePolicies({
            project: env.project,
            maxResults: 1000,
            pageToken,
          });
          for (const policy of response.responsePolicies ?? []) {
            if (
              Object.keys(policy.labels ?? {}).some((key) =>
                key.startsWith(ALCHEMY_LABEL_PREFIX),
              )
            ) {
              found.push(toAttrs(policy, env.project));
            }
          }
          pageToken = response.nextPageToken;
          if (pageToken === undefined || pageToken === "") break;
        }
        return found;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const responsePolicyName = yield* toResponsePolicyName(
        id,
        news.responsePolicyName,
        output?.responsePolicyName,
      );
      const description = news.description ?? "";
      const networks = desiredNetworks(env.project, news.networks);
      const gkeClusters = desiredClusters(news.gkeClusters);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(env.project, responsePolicyName);

      if (current === undefined) {
        const created = yield* dns
          .createResponsePolicies({
            project: env.project,
            body: {
              responsePolicyName,
              description,
              labels: desiredLabels,
              networks: networks.map((networkUrl) => ({ networkUrl })),
              gkeClusters: gkeClusters.map((gkeClusterName) => ({
                gkeClusterName,
              })),
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              getByName(env.project, responsePolicyName),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ResponsePolicyNotResolved({ responsePolicyName });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged = (current.description ?? "") !== description;
      const networksChanged = !sameNetworks(
        observedNetworks(current),
        networks,
      );
      const clustersChanged = !sameList(observedClusters(current), gkeClusters);

      if (
        labelsChanged ||
        descriptionChanged ||
        networksChanged ||
        clustersChanged
      ) {
        const body: dns.ResponsePolicy = {};
        if (labelsChanged) body.labels = desiredLabels;
        if (descriptionChanged) body.description = description;
        if (networksChanged) {
          body.networks = networks.map((networkUrl) => ({ networkUrl }));
        }
        if (clustersChanged) {
          body.gkeClusters = gkeClusters.map((gkeClusterName) => ({
            gkeClusterName,
          }));
        }
        const patched = yield* dns.patchResponsePolicies({
          project: env.project,
          responsePolicy: responsePolicyName,
          body,
        });
        current =
          patched.responsePolicy ??
          (yield* getByName(env.project, responsePolicyName)) ??
          current;
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const project = output.project;
      const responsePolicyName = output.responsePolicyName;
      const detach = Effect.gen(function* () {
        yield* emptyRules(project, responsePolicyName);
        yield* dns
          .patchResponsePolicies({
            project,
            responsePolicy: responsePolicyName,
            body: { networks: [], gkeClusters: [] },
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      });
      const attempt = dns
        .deleteResponsePolicies({
          project,
          responsePolicy: responsePolicyName,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* detach.pipe(Effect.andThen(attempt)).pipe(
        Effect.catchIf(
          (error) => error._tag === "Conflict" || error._tag === "BadRequest",
          () => detach.pipe(Effect.andThen(attempt)),
        ),
        Effect.retry({
          while: (error) =>
            error._tag === "Conflict" || error._tag === "BadRequest",
          times: 8,
          schedule: Schedule.spaced("2 seconds"),
        }),
      );
    }),
  });
