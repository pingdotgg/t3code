import * as ga from "@distilled.cloud/aws/global-accelerator";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { retryUntilListenerDeletable, withGaRegion } from "./common.ts";

export interface PortRange {
  /**
   * First port in the range of ports, inclusive.
   */
  fromPort: number;
  /**
   * Last port in the range of ports, inclusive.
   */
  toPort: number;
}

export interface ListenerProps {
  /**
   * ARN of the accelerator the listener attaches to. Changing it replaces
   * the listener.
   */
  acceleratorArn: string;
  /**
   * The port ranges the listener accepts client connections on (up to 10).
   */
  portRanges: PortRange[];
  /**
   * The protocol for connections from clients to the accelerator.
   */
  protocol: "TCP" | "UDP";
  /**
   * Client affinity. `SOURCE_IP` routes a given client to the same endpoint
   * regardless of source port, for stateful applications.
   * @default "NONE"
   */
  clientAffinity?: "NONE" | "SOURCE_IP";
}

export interface Listener extends Resource<
  "AWS.GlobalAccelerator.Listener",
  ListenerProps,
  {
    /** The ARN of the listener. */
    listenerArn: string;
    /** The ARN of the accelerator the listener is attached to. */
    acceleratorArn: string;
    /** The port ranges the listener accepts connections on. */
    portRanges: PortRange[];
    /** The listener protocol: `TCP` or `UDP`. */
    protocol: string;
    /** The client affinity setting: `NONE` or `SOURCE_IP`. */
    clientAffinity: string;
  },
  never,
  Providers
> {}

/**
 * A Global Accelerator listener that accepts inbound client connections on
 * an accelerator's static IP addresses, on one or more port ranges.
 *
 * Port ranges, protocol, and client affinity are all updatable in place;
 * only moving the listener to a different accelerator replaces it. Attach
 * `EndpointGroup`s to route the accepted traffic to regional endpoints.
 * @resource
 * @section Creating Listeners
 * @example TCP Listener
 * ```typescript
 * const listener = yield* GlobalAccelerator.Listener("Web", {
 *   acceleratorArn: accelerator.acceleratorArn,
 *   portRanges: [{ fromPort: 80, toPort: 80 }],
 *   protocol: "TCP",
 * });
 * ```
 *
 * @example Sticky UDP Listener with Multiple Port Ranges
 * ```typescript
 * const listener = yield* GlobalAccelerator.Listener("Game", {
 *   acceleratorArn: accelerator.acceleratorArn,
 *   portRanges: [
 *     { fromPort: 3000, toPort: 3100 },
 *     { fromPort: 4000, toPort: 4000 },
 *   ],
 *   protocol: "UDP",
 *   clientAffinity: "SOURCE_IP",
 * });
 * ```
 */
export const Listener = Resource<Listener>("AWS.GlobalAccelerator.Listener");

const toWirePortRanges = (ranges: PortRange[]): ga.PortRange[] =>
  ranges.map((r) => ({ FromPort: r.fromPort, ToPort: r.toPort }));

const fromWirePortRanges = (ranges: ga.PortRange[] | undefined): PortRange[] =>
  (ranges ?? []).map((r) => ({
    fromPort: r.FromPort ?? 0,
    toPort: r.ToPort ?? 0,
  }));

const normalizeRanges = (ranges: PortRange[]) =>
  JSON.stringify(
    [...ranges].sort((a, b) => a.fromPort - b.fromPort || a.toPort - b.toPort),
  );

// Listener ARNs embed the parent accelerator ARN:
// arn:aws:globalaccelerator::{account}:accelerator/{id}/listener/{id}
const acceleratorArnOf = (listenerArn: string) =>
  listenerArn.split("/listener/")[0]!;

const toAttributes = (l: ga.Listener, listenerArn: string) => ({
  listenerArn,
  acceleratorArn: acceleratorArnOf(listenerArn),
  portRanges: fromWirePortRanges(l.PortRanges),
  protocol: l.Protocol ?? "TCP",
  clientAffinity: l.ClientAffinity ?? "NONE",
});

const describeListener = Effect.fn(function* (listenerArn: string) {
  return yield* withGaRegion(
    ga.describeListener({ ListenerArn: listenerArn }),
  ).pipe(
    Effect.map((r) => r.Listener),
    Effect.catchTag("ListenerNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );
});

// Recover a listener without a cached ARN (lost state / crashed create) by
// matching its exact port-range set under the parent accelerator.
const findListener = Effect.fn(function* (
  acceleratorArn: string | undefined,
  portRanges: PortRange[] | undefined,
) {
  if (!acceleratorArn || !portRanges) return undefined;
  const desired = normalizeRanges(portRanges);
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
  return listeners.find(
    (l) => normalizeRanges(fromWirePortRanges(l.PortRanges)) === desired,
  );
});

export const ListenerProvider = () =>
  Provider.succeed(Listener, {
    stables: ["listenerArn", "acceleratorArn"],
    // Sub-resource keyed entirely by its parent accelerator (and untagged) —
    // account-wide enumeration happens via the Accelerator resource.
    list: () => Effect.succeed([]),
    read: Effect.fn(function* ({ olds, output }) {
      if (output?.listenerArn) {
        const live = yield* describeListener(output.listenerArn);
        if (live) return toAttributes(live, output.listenerArn);
      }
      const found = yield* findListener(olds?.acceleratorArn, olds?.portRanges);
      if (!found?.ListenerArn) return undefined;
      return toAttributes(found, found.ListenerArn);
    }),
    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news)) return undefined;
      if (news.acceleratorArn !== olds.acceleratorArn) {
        return { action: "replace" } as const;
      }
      // portRanges / protocol / clientAffinity update in place.
    }),
    reconcile: Effect.fn(function* ({ news, output, instanceId, session }) {
      // Observe — cached ARN first, then match by port ranges under the
      // parent accelerator (covers create-then-persist-failure).
      let listenerArn: string | undefined;
      let live: ga.Listener | undefined;
      if (output?.listenerArn) {
        live = yield* describeListener(output.listenerArn);
        if (live) listenerArn = output.listenerArn;
      }
      if (!listenerArn) {
        const found = yield* findListener(news.acceleratorArn, news.portRanges);
        if (found?.ListenerArn) {
          live = found;
          listenerArn = found.ListenerArn;
        }
      }

      // Ensure — create if missing.
      if (!listenerArn) {
        const created = yield* withGaRegion(
          ga.createListener({
            AcceleratorArn: news.acceleratorArn,
            PortRanges: toWirePortRanges(news.portRanges),
            Protocol: news.protocol,
            ClientAffinity: news.clientAffinity,
            IdempotencyToken: instanceId,
          }),
        ).pipe(Effect.map((r) => r.Listener));
        if (!created?.ListenerArn) {
          return yield* Effect.die(
            new Error("CreateListener returned no listener"),
          );
        }
        live = created;
        listenerArn = created.ListenerArn;
      }

      // Sync — diff observed vs desired; single update applies the delta.
      const desiredAffinity = news.clientAffinity ?? "NONE";
      const drift =
        normalizeRanges(fromWirePortRanges(live?.PortRanges)) !==
          normalizeRanges(news.portRanges) ||
        (live?.Protocol ?? "TCP") !== news.protocol ||
        (live?.ClientAffinity ?? "NONE") !== desiredAffinity;
      if (drift) {
        const updated = yield* withGaRegion(
          ga.updateListener({
            ListenerArn: listenerArn,
            PortRanges: toWirePortRanges(news.portRanges),
            Protocol: news.protocol,
            ClientAffinity: desiredAffinity,
          }),
        ).pipe(Effect.map((r) => r.Listener));
        if (updated) live = updated;
      }

      yield* session.note(listenerArn);
      return toAttributes(live ?? {}, listenerArn);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* retryUntilListenerDeletable(
        withGaRegion(ga.deleteListener({ ListenerArn: output.listenerArn })),
      ).pipe(Effect.catchTag("ListenerNotFoundException", () => Effect.void));
    }),
  });
