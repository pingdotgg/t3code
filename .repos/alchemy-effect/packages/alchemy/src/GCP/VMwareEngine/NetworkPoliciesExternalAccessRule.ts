import * as vmwareengine from "@distilled.cloud/gcp/vmwareengine_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  VmwareengineNotResolved,
  changedFields,
  collectPages,
  createInternalLabels,
  encodeOwnership,
  expandName,
  hasAlchemyLabels,
  hasOwnershipMarker,
  listAcrossLocations,
  locationFromName,
  normalizeLocation,
  parseName,
  parseOwnership,
  replaceOnIdentity,
  rfc1035,
  sameJson,
  toPhysicalId,
  waitForOperation,
  waitUntilGone,
  waitUntilPresent,
  waitUntilReady,
} from "./internal.ts";

const COLLECTION = "externalAccessRules";
const PARENT_COLLECTION = "networkPolicies";

export type IpRange = {
  /** A single IP address (`10.0.0.5`). */
  ipAddress?: string;
  /** A CIDR range (`10.0.0.0/24`). */
  ipAddressRange?: string;
  /**
   * ExternalAddress resource name reserved in the parent network policy
   * scope.
   */
  externalAddress?: string;
};

export type ExternalAccessRuleAction =
  | vmwareengine.ExternalAccessRuleActionEnum
  | (string & {});

export type NetworkPoliciesExternalAccessRuleProps = {
  /**
   * Parent NetworkPolicy resource name
   * (`projects/{project}/locations/{location}/networkPolicies/{networkPolicy}`)
   * or the policy id. Immutable — changing it replaces the rule.
   */
  networkPolicy: string;
  /**
   * Rule id (the `{externalAccessRule}` segment of
   * `.../networkPolicies/{networkPolicy}/externalAccessRules/{externalAccessRule}`).
   * If omitted, a unique RFC1035 name is generated. Immutable.
   */
  externalAccessRuleId?: string;
  /**
   * Region of the parent policy. Inferred from `networkPolicy` when that
   * value is a full resource name. Immutable.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * Rule priority (`100`–`4096`). Lower integers take precedence.
   * @default 1000
   */
  priority?: number;
  /**
   * Action (`ALLOW` or `DENY`).
   * @default "ALLOW"
   */
  action?: ExternalAccessRuleAction;
  /**
   * IP protocol (`tcp`, `udp`, or `icmp`).
   * @default "tcp"
   */
  ipProtocol?: string;
  /**
   * Source IP ranges. Use `0.0.0.0/0` to match all sources.
   */
  sourceIpRanges?: IpRange[];
  /**
   * Source ports (`["22"]`, `["80","443"]`, `["12345-12349"]`). Use
   * `["0-65535"]` to match all. TCP/UDP only.
   */
  sourcePorts?: string[];
  /**
   * Destination IP ranges. Must be reserved external IPs in the parent
   * policy, or `0.0.0.0/0` for all.
   */
  destinationIpRanges?: IpRange[];
  /**
   * Destination ports. TCP/UDP only.
   */
  destinationPorts?: string[];
  /**
   * Human-readable description. Rules have no labels field, so Alchemy
   * stamps ownership into a `[alchemy …]` prefix and strips it from
   * attributes.
   */
  description?: string;
};

export type NetworkPoliciesExternalAccessRule = Resource<
  "GCP.VMwareEngine.NetworkPoliciesExternalAccessRule",
  NetworkPoliciesExternalAccessRuleProps,
  {
    /** Full resource name. */
    name: string;
    /** Rule id (last path segment). */
    externalAccessRuleId: string;
    /** Parent NetworkPolicy resource name. */
    networkPolicy: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Rule priority. */
    priority: number | undefined;
    /** Action (`ALLOW` or `DENY`). */
    action: string | undefined;
    /** IP protocol. */
    ipProtocol: string | undefined;
    /** Source IP ranges. */
    sourceIpRanges: IpRange[];
    /** Source ports. */
    sourcePorts: string[];
    /** Destination IP ranges. */
    destinationIpRanges: IpRange[];
    /** Destination ports. */
    destinationPorts: string[];
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Server-reported state. */
    state: string | undefined;
    /** System-generated unique identifier. */
    uid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An inbound firewall rule on a VMware Engine network policy that filters
 * traffic destined to ExternalAddress resources.
 *
 * Rules have no labels field, so Alchemy stamps ownership into the
 * description for `list` / nuke. Changing the parent policy, rule id, or
 * location replaces the rule. Priority, action, protocol, ranges, ports,
 * and description update in place.
 *
 * ### Creating a NetworkPoliciesExternalAccessRule
 * **Example:** Allow HTTPS from anywhere
 * ```typescript
 * const rule = yield* GCP.VMwareEngine.NetworkPoliciesExternalAccessRule(
 *   "Https",
 *   {
 *     networkPolicy: policy.name,
 *     action: "ALLOW",
 *     ipProtocol: "tcp",
 *     priority: 1000,
 *     sourceIpRanges: [{ ipAddressRange: "0.0.0.0/0" }],
 *     sourcePorts: ["0-65535"],
 *     destinationIpRanges: [{ ipAddressRange: "0.0.0.0/0" }],
 *     destinationPorts: ["443"],
 *     description: "allow https",
 *   },
 * );
 * ```
 *
 * @resource
 * @category VMwareEngine
 */
export const NetworkPoliciesExternalAccessRule =
  Resource<NetworkPoliciesExternalAccessRule>(
    "GCP.VMwareEngine.NetworkPoliciesExternalAccessRule",
  );

const parentPolicyName = (
  project: string,
  location: string,
  networkPolicy: string,
) => expandName(networkPolicy, project, location, PARENT_COLLECTION);

const resourceNameOf = (parent: string, ruleId: string) =>
  `${parent}/${COLLECTION}/${ruleId}`;

const ipRangesOf = (
  values: readonly vmwareengine.IpRange[] | readonly IpRange[] | undefined,
): IpRange[] =>
  (values ?? []).map((range) => ({
    ipAddress: range.ipAddress,
    ipAddressRange: range.ipAddressRange,
    externalAddress: range.externalAddress,
  }));

const toAttrs = (
  item: vmwareengine.ExternalAccessRule,
  project: string,
  region: string,
) => {
  const name = item.name ?? "";
  const parsed = parseName(name, COLLECTION, region);
  const ownership = parseOwnership(item.description);
  return {
    name,
    externalAccessRuleId: parsed.id,
    networkPolicy: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    priority: item.priority,
    action: item.action,
    ipProtocol: item.ipProtocol,
    sourceIpRanges: ipRangesOf(item.sourceIpRanges),
    sourcePorts: item.sourcePorts ?? [],
    destinationIpRanges: ipRangesOf(item.destinationIpRanges),
    destinationPorts: item.destinationPorts ?? [],
    description: ownership.text,
    state: item.state,
    uid: item.uid,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  vmwareengine
    .getProjectsLocationsNetworkPoliciesExternalAccessRules({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const NetworkPoliciesExternalAccessRuleProvider = () =>
  Provider.succeed(NetworkPoliciesExternalAccessRule, {
    stables: [
      "name",
      "externalAccessRuleId",
      "networkPolicy",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      return replaceOnIdentity({
        previousId: olds?.externalAccessRuleId ?? output?.externalAccessRuleId,
        nextId: news.externalAccessRuleId
          ? rfc1035(news.externalAccessRuleId, "rule")
          : (olds?.externalAccessRuleId ?? output?.externalAccessRuleId),
        previousLocation,
        nextLocation: normalizeLocation(
          news.location ??
            locationFromName(news.networkPolicy, previousLocation),
          env.region,
        ),
        previousParent: olds?.networkPolicy ?? output?.networkPolicy,
        nextParent: news.networkPolicy,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ??
          output?.location ??
          (olds?.networkPolicy
            ? locationFromName(olds.networkPolicy, env.region)
            : undefined),
        env.region,
      );
      const parent = parentPolicyName(
        env.project,
        location,
        olds?.networkPolicy ?? output?.networkPolicy ?? "",
      );
      const ruleId = yield* toPhysicalId(
        id,
        olds?.externalAccessRuleId,
        output?.externalAccessRuleId,
        "rule",
      );
      const name = output?.name ?? resourceNameOf(parent, ruleId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      const { labels } = parseOwnership(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const policies = yield* listAcrossLocations(
          env.project,
          env.region,
          (parent) =>
            collectPages(
              vmwareengine.listProjectsLocationsNetworkPolicies.pages({
                parent,
                pageSize: 1000,
              }),
              (page) => page.networkPolicies,
            ),
        );
        const nested = yield* Effect.forEach(
          policies.filter((policy) => (policy.name ?? "").length > 0),
          (policy) =>
            collectPages(
              vmwareengine.listProjectsLocationsNetworkPoliciesExternalAccessRules.pages(
                {
                  parent: policy.name ?? "",
                  pageSize: 1000,
                },
              ),
              (page) => page.externalAccessRules,
            ),
          { concurrency: 4 },
        );
        return nested
          .flat()
          .filter((item) => hasOwnershipMarker(item.description))
          .map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ??
          output?.location ??
          locationFromName(news.networkPolicy, env.region),
        env.region,
      );
      const parent = parentPolicyName(
        env.project,
        location,
        news.networkPolicy,
      );
      const ruleId = yield* toPhysicalId(
        id,
        news.externalAccessRuleId,
        output?.externalAccessRuleId,
        "rule",
      );
      const name = resourceNameOf(parent, ruleId);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeOwnership(ownership, news.description);
      const priority = news.priority ?? 1000;
      const action = news.action ?? "ALLOW";
      const ipProtocol = news.ipProtocol ?? "tcp";
      const sourceIpRanges = news.sourceIpRanges ?? [
        { ipAddressRange: "0.0.0.0/0" },
      ];
      const destinationIpRanges = news.destinationIpRanges ?? [
        { ipAddressRange: "0.0.0.0/0" },
      ];
      const sourcePorts = news.sourcePorts ?? ["0-65535"];
      const destinationPorts = news.destinationPorts ?? ["0-65535"];

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* vmwareengine
          .createProjectsLocationsNetworkPoliciesExternalAccessRules({
            parent,
            externalAccessRuleId: ruleId,
            body: {
              priority,
              action,
              ipProtocol,
              sourceIpRanges,
              destinationIpRanges,
              sourcePorts,
              destinationPorts,
              description: desiredDescription,
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

      if (current === undefined) {
        return yield* new VmwareengineNotResolved({ name });
      }

      current = yield* waitUntilReady(
        getByName(current.name ?? name),
        current.name ?? name,
        (item) => item.state,
      );

      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const priorityChanged = (current.priority ?? 0) !== priority;
      const actionChanged = (current.action ?? "") !== action;
      const protocolChanged = (current.ipProtocol ?? "") !== ipProtocol;
      const sourceRangesChanged = !sameJson(
        ipRangesOf(current.sourceIpRanges),
        sourceIpRanges,
      );
      const destRangesChanged = !sameJson(
        ipRangesOf(current.destinationIpRanges),
        destinationIpRanges,
      );
      const sourcePortsChanged = !sameJson(current.sourcePorts, sourcePorts);
      const destPortsChanged = !sameJson(
        current.destinationPorts,
        destinationPorts,
      );
      const updateMask = changedFields([
        ["description", descriptionChanged],
        ["priority", priorityChanged],
        ["action", actionChanged],
        ["ipProtocol", protocolChanged],
        ["sourceIpRanges", sourceRangesChanged],
        ["destinationIpRanges", destRangesChanged],
        ["sourcePorts", sourcePortsChanged],
        ["destinationPorts", destPortsChanged],
      ]);

      if (updateMask.length > 0) {
        const operation =
          yield* vmwareengine.patchProjectsLocationsNetworkPoliciesExternalAccessRules(
            {
              name: current.name ?? name,
              updateMask: updateMask.join(","),
              body: {
                name: current.name ?? name,
                description: desiredDescription,
                priority,
                action,
                ipProtocol,
                sourceIpRanges,
                destinationIpRanges,
                sourcePorts,
                destinationPorts,
              },
            },
          );
        yield* waitForOperation(operation);
        current = yield* waitUntilReady(
          getByName(current.name ?? name),
          current.name ?? name,
          (item) => item.state,
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* vmwareengine
        .deleteProjectsLocationsNetworkPoliciesExternalAccessRules({
          name: output.name,
        })
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
