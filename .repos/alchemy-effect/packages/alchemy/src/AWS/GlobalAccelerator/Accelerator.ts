import * as ga from "@distilled.cloud/aws/global-accelerator";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  retryGaDeletion,
  retryGaTransaction,
  retryUntilAcceleratorDeletable,
  retryUntilListenerDeletable,
  withGaRegion,
} from "./common.ts";

export interface AcceleratorProps {
  /**
   * Name of the accelerator. Up to 64 characters; letters, digits, and
   * hyphens only, and must not begin or end with a hyphen.
   * @default ${app}-${id}-${stage}-${suffix}
   */
  name?: string;
  /**
   * The IP address type that the accelerator's static addresses use.
   * `DUAL_STACK` assigns both IPv4 and IPv6 addresses.
   * @default "IPV4"
   */
  ipAddressType?: "IPV4" | "DUAL_STACK";
  /**
   * Optionally specify one or two static IPv4 addresses from your own
   * BYOIP address pools. Changing them replaces the accelerator.
   * @default addresses assigned from Amazon's pool
   */
  ipAddresses?: string[];
  /**
   * Whether the accelerator accepts and routes traffic. A disabled
   * accelerator keeps its static IP addresses but serves nothing.
   * @default true
   */
  enabled?: boolean;
  /**
   * Publish flow logs describing the traffic the accelerator serves to an
   * S3 bucket. The bucket must live in the same account and carry a bucket
   * policy granting `delivery.logs.amazonaws.com` permission to
   * `s3:PutObject` (and `s3:GetBucketAcl`). Omit to keep flow logs
   * disabled.
   * @default disabled
   */
  flowLogs?: FlowLogs;
  /**
   * Tags to apply to the accelerator. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface FlowLogs {
  /**
   * Name of the S3 bucket flow logs are delivered to.
   */
  bucket: string;
  /**
   * Key prefix for the flow-log objects within the bucket.
   * @default logs are delivered under `AWSLogs/` at the bucket root
   */
  prefix?: string;
}

export interface Accelerator extends Resource<
  "AWS.GlobalAccelerator.Accelerator",
  AcceleratorProps,
  {
    /** The ARN of the accelerator. */
    acceleratorArn: string;
    /** The name of the accelerator. */
    name: string;
    /** The DNS name that points to the accelerator's static IPv4 addresses. */
    dnsName: string | undefined;
    /** The DNS name for dual-stack (IPv4 + IPv6) accelerators. */
    dualStackDnsName: string | undefined;
    /** The static anycast IP addresses assigned to the accelerator. */
    ipAddresses: string[];
    /** The IP address type: `IPV4` or `DUAL_STACK`. */
    ipAddressType: string;
    /** Whether the accelerator accepts and routes traffic. */
    enabled: boolean;
    /** Deployment status: `DEPLOYED` or `IN_PROGRESS`. */
    status: string;
    /** Whether flow logs are published to S3. */
    flowLogsEnabled: boolean;
    /** The S3 bucket receiving flow logs, when enabled. */
    flowLogsS3Bucket: string | undefined;
    /** The S3 key prefix for flow logs, when enabled. */
    flowLogsS3Prefix: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An AWS Global Accelerator standard accelerator — two anycast static IP
 * addresses that route client traffic over the AWS global network to the
 * closest healthy regional endpoint.
 *
 * Accelerators are global resources (the control-plane API lives in
 * us-west-2 regardless of your deployment region — alchemy pins it
 * automatically). Attach `Listener`s to accept traffic and `EndpointGroup`s
 * to route it to ALBs, NLBs, EC2 instances, or Elastic IPs per region.
 * @resource
 * @section Creating Accelerators
 * @example Basic Accelerator
 * ```typescript
 * import * as GlobalAccelerator from "alchemy/AWS/GlobalAccelerator";
 *
 * const accelerator = yield* GlobalAccelerator.Accelerator("Edge");
 * ```
 *
 * @example Dual-Stack Accelerator
 * ```typescript
 * const accelerator = yield* GlobalAccelerator.Accelerator("Edge", {
 *   ipAddressType: "DUAL_STACK",
 * });
 * ```
 *
 * @section Flow Logs
 * @example Publish Flow Logs to S3
 * ```typescript
 * // the bucket policy must grant delivery.logs.amazonaws.com
 * // s3:PutObject + s3:GetBucketAcl
 * const accelerator = yield* GlobalAccelerator.Accelerator("Edge", {
 *   flowLogs: { bucket: logBucket.bucketName, prefix: "ga-flow-logs" },
 * });
 * ```
 *
 * @section Routing Traffic
 * @example Accelerator with Listener and Endpoint Group
 * ```typescript
 * const accelerator = yield* GlobalAccelerator.Accelerator("Edge");
 * const listener = yield* GlobalAccelerator.Listener("Web", {
 *   acceleratorArn: accelerator.acceleratorArn,
 *   portRanges: [{ fromPort: 443, toPort: 443 }],
 *   protocol: "TCP",
 * });
 * yield* GlobalAccelerator.EndpointGroup("UsWest2", {
 *   listenerArn: listener.listenerArn,
 *   endpointGroupRegion: "us-west-2",
 *   endpoints: [{ endpointId: alb.loadBalancerArn }],
 * });
 * ```
 */
export const Accelerator = Resource<Accelerator>(
  "AWS.GlobalAccelerator.Accelerator",
);

const createAcceleratorName = Effect.fn(function* (
  id: string,
  props: { name?: string | undefined },
) {
  return props.name ?? (yield* createPhysicalName({ id, maxLength: 64 }));
});

const toAttributes = (
  a: ga.Accelerator,
  acceleratorArn: string,
  flowLogs?: ga.AcceleratorAttributes,
) => ({
  acceleratorArn,
  name: a.Name ?? "",
  dnsName: a.DnsName,
  dualStackDnsName: a.DualStackDnsName,
  ipAddresses: a.IpSets?.flatMap((set) => set.IpAddresses ?? []) ?? [],
  ipAddressType: a.IpAddressType ?? "IPV4",
  enabled: a.Enabled ?? true,
  status: a.Status ?? "IN_PROGRESS",
  flowLogsEnabled: flowLogs?.FlowLogsEnabled ?? false,
  flowLogsS3Bucket: flowLogs?.FlowLogsS3Bucket,
  flowLogsS3Prefix: flowLogs?.FlowLogsS3Prefix,
});

const describeAccelerator = Effect.fn(function* (acceleratorArn: string) {
  return yield* withGaRegion(
    ga.describeAccelerator({ AcceleratorArn: acceleratorArn }),
  ).pipe(
    Effect.map((r) => r.Accelerator),
    Effect.catchTag("AcceleratorNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );
});

const describeFlowLogs = Effect.fn(function* (acceleratorArn: string) {
  return yield* withGaRegion(
    ga.describeAcceleratorAttributes({ AcceleratorArn: acceleratorArn }),
  ).pipe(
    Effect.map((r) => r.AcceleratorAttributes),
    Effect.catchTag("AcceleratorNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );
});

const findAcceleratorByName = Effect.fn(function* (name: string) {
  const accelerators = yield* withGaRegion(
    ga.listAccelerators.items({}).pipe(Stream.runCollect),
  );
  return Array.from(accelerators).find((a) => a.Name === name);
});

const fetchTags = Effect.fn(function* (resourceArn: string) {
  return yield* withGaRegion(
    ga.listTagsForResource({ ResourceArn: resourceArn }),
  ).pipe(
    Effect.map((r) =>
      Object.fromEntries((r.Tags ?? []).map((t) => [t.Key, t.Value])),
    ),
    Effect.catch(() => Effect.succeed({} as Record<string, string>)),
  );
});

/**
 * Global Accelerator's listener and endpoint-group resources are untagged
 * children and cannot be enumerated independently by account-wide nuke.
 * When nuke explicitly force-deletes an accelerator, discover and remove the
 * complete child tree first. Normal stack destroy still relies on dependency
 * ordering and deletes each child through its own provider.
 */
const deleteAcceleratorChildren = Effect.fn(function* (acceleratorArn: string) {
  const listeners = yield* withGaRegion(
    ga.listListeners
      .items({ AcceleratorArn: acceleratorArn })
      .pipe(Stream.runCollect),
  ).pipe(
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("AcceleratorNotFoundException", () =>
      Effect.succeed([] as ga.Listener[]),
    ),
  );

  // GA serializes mutations per accelerator. Keep this traversal sequential
  // so deleting several children does not manufacture transaction conflicts.
  yield* Effect.forEach(
    listeners,
    Effect.fn(function* (listener) {
      if (!listener.ListenerArn) return;
      const listenerArn = listener.ListenerArn;
      const endpointGroups = yield* withGaRegion(
        ga.listEndpointGroups
          .items({ ListenerArn: listenerArn })
          .pipe(Stream.runCollect),
      ).pipe(
        Effect.map((chunk) => Array.from(chunk)),
        Effect.catchTag("ListenerNotFoundException", () =>
          Effect.succeed([] as ga.EndpointGroup[]),
        ),
      );

      yield* Effect.forEach(
        endpointGroups,
        (group) =>
          group.EndpointGroupArn
            ? retryGaDeletion(
                withGaRegion(
                  ga.deleteEndpointGroup({
                    EndpointGroupArn: group.EndpointGroupArn,
                  }),
                ),
              ).pipe(
                Effect.catchTag(
                  "EndpointGroupNotFoundException",
                  () => Effect.void,
                ),
              )
            : Effect.void,
        { discard: true },
      );

      // Endpoint-group detachment is asynchronous. The same bounded retry
      // used by the child provider waits until the listener is deletable.
      yield* retryUntilListenerDeletable(
        withGaRegion(ga.deleteListener({ ListenerArn: listenerArn })),
      ).pipe(Effect.catchTag("ListenerNotFoundException", () => Effect.void));
    }),
    { discard: true },
  );
});

export const AcceleratorProvider = () =>
  Provider.succeed(Accelerator, {
    stables: ["acceleratorArn", "dnsName", "dualStackDnsName", "ipAddresses"],
    // Top-level, account-scoped collection: enumerate every accelerator.
    list: () =>
      withGaRegion(
        ga.listAccelerators.items({}).pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk)
              .filter((a) => a.AcceleratorArn !== undefined)
              .map((a) => toAttributes(a, a.AcceleratorArn!)),
          ),
        ),
      ),
    read: Effect.fn(function* ({ id, olds, output }) {
      let live = output?.acceleratorArn
        ? yield* describeAccelerator(output.acceleratorArn)
        : undefined;
      if (!live?.AcceleratorArn) {
        // No cached ARN (or it vanished) — fall back to the deterministic
        // physical name to recover from lost state / support adoption.
        const name = yield* createAcceleratorName(id, olds ?? {});
        live = yield* findAcceleratorByName(name);
      }
      if (!live?.AcceleratorArn) return undefined;
      const flowLogs = yield* describeFlowLogs(live.AcceleratorArn);
      const attrs = toAttributes(live, live.AcceleratorArn, flowLogs);
      const tags = yield* fetchTags(live.AcceleratorArn);
      return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
    }),
    diff: Effect.fn(function* ({ id, news, olds }) {
      if (!isResolved(news)) return undefined;
      // Static BYOIP addresses are the accelerator's identity — changing
      // them requires a replacement. Name, ipAddressType, and enabled are
      // all mutable via updateAccelerator.
      if (
        JSON.stringify(news.ipAddresses ?? []) !==
        JSON.stringify(olds.ipAddresses ?? [])
      ) {
        return { action: "replace" } as const;
      }
      const oldName = yield* createAcceleratorName(id, olds);
      const newName = yield* createAcceleratorName(id, news);
      if (oldName !== newName) {
        // Renames are applied in place by reconcile.
        return undefined;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news, output, instanceId, session }) {
      const name = yield* createAcceleratorName(id, news);
      const internalTags = yield* createInternalTags(id);
      const desiredTags: Record<string, string> = {
        ...news.tags,
        ...internalTags,
      };
      const desiredEnabled = news.enabled ?? true;

      // Observe — cached ARN first, deterministic name as fallback (covers
      // create-then-persist-failure and adoption).
      let live = output?.acceleratorArn
        ? yield* describeAccelerator(output.acceleratorArn)
        : undefined;
      if (!live?.AcceleratorArn) {
        live = yield* findAcceleratorByName(output?.name ?? name);
      }

      // Ensure — create if missing. The idempotency token (derived from the
      // instance id) makes a crashed-and-retried create safe.
      if (!live?.AcceleratorArn) {
        live = yield* retryGaTransaction(
          withGaRegion(
            ga.createAccelerator({
              Name: name,
              IpAddressType: news.ipAddressType,
              IpAddresses: news.ipAddresses,
              Enabled: desiredEnabled,
              IdempotencyToken: instanceId,
              Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                Key,
                Value,
              })),
            }),
          ),
        ).pipe(Effect.map((r) => r.Accelerator));
      }
      if (!live?.AcceleratorArn) {
        return yield* Effect.die(
          new Error("CreateAccelerator returned no accelerator"),
        );
      }
      const acceleratorArn = live.AcceleratorArn;

      // Sync settings — diff observed vs desired, apply only the delta.
      const update: ga.UpdateAcceleratorRequest = {
        AcceleratorArn: acceleratorArn,
      };
      let dirty = false;
      if ((live.Name ?? "") !== name) {
        update.Name = name;
        dirty = true;
      }
      if (
        news.ipAddressType !== undefined &&
        live.IpAddressType !== news.ipAddressType
      ) {
        update.IpAddressType = news.ipAddressType;
        dirty = true;
      }
      if ((live.Enabled ?? true) !== desiredEnabled) {
        update.Enabled = desiredEnabled;
        dirty = true;
      }
      if (dirty) {
        const updated = yield* retryGaTransaction(
          withGaRegion(ga.updateAccelerator(update)),
        ).pipe(Effect.map((r) => r.Accelerator));
        if (updated) live = updated;
      }

      // Sync flow logs — diff observed attributes against the desired
      // flowLogs prop; only call updateAcceleratorAttributes on drift.
      let flowLogs = yield* describeFlowLogs(acceleratorArn);
      const desiredFlowLogsEnabled = news.flowLogs !== undefined;
      const flowLogsDrift =
        (flowLogs?.FlowLogsEnabled ?? false) !== desiredFlowLogsEnabled ||
        (desiredFlowLogsEnabled &&
          (flowLogs?.FlowLogsS3Bucket !== news.flowLogs!.bucket ||
            (news.flowLogs!.prefix !== undefined &&
              flowLogs?.FlowLogsS3Prefix !== news.flowLogs!.prefix)));
      if (flowLogsDrift) {
        flowLogs = yield* retryGaTransaction(
          withGaRegion(
            ga.updateAcceleratorAttributes({
              AcceleratorArn: acceleratorArn,
              FlowLogsEnabled: desiredFlowLogsEnabled,
              ...(desiredFlowLogsEnabled
                ? {
                    FlowLogsS3Bucket: news.flowLogs!.bucket,
                    FlowLogsS3Prefix: news.flowLogs!.prefix,
                  }
                : {}),
            }),
          ),
        ).pipe(Effect.map((r) => r.AcceleratorAttributes));
      }

      // Sync tags against OBSERVED cloud tags so adoption converges.
      const observedTags = yield* fetchTags(acceleratorArn);
      const { upsert, removed } = diffTags(observedTags, desiredTags);
      if (upsert.length > 0) {
        yield* withGaRegion(
          ga.tagResource({ ResourceArn: acceleratorArn, Tags: upsert }),
        );
      }
      if (removed.length > 0) {
        yield* withGaRegion(
          ga.untagResource({ ResourceArn: acceleratorArn, TagKeys: removed }),
        );
      }

      yield* session.note(acceleratorArn);
      return toAttributes(live, acceleratorArn, flowLogs);
    }),
    delete: Effect.fn(function* ({ output, session, force }) {
      const acceleratorArn = output.acceleratorArn;
      if (force) {
        yield* session.note(
          "deleting accelerator listeners and endpoint groups",
        );
        yield* deleteAcceleratorChildren(acceleratorArn);
      }
      // An accelerator must be disabled before it can be deleted.
      const exists = yield* retryGaTransaction(
        withGaRegion(
          ga.updateAccelerator({
            AcceleratorArn: acceleratorArn,
            Enabled: false,
          }),
        ),
      ).pipe(
        Effect.map(() => true),
        Effect.catchTag("AcceleratorNotFoundException", () =>
          Effect.succeed(false),
        ),
      );
      if (!exists) return;
      yield* session.note("waiting for accelerator to disable");
      // The disable propagates asynchronously; deleteAccelerator rejects with
      // AcceleratorNotDisabledException until it lands, so retry bounded.
      yield* retryUntilAcceleratorDeletable(
        withGaRegion(ga.deleteAccelerator({ AcceleratorArn: acceleratorArn })),
      ).pipe(
        Effect.catchTag("AcceleratorNotFoundException", () => Effect.void),
      );
    }),
  });
