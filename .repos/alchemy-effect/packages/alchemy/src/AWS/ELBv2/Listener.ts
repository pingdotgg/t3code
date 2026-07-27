import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { AccountID } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import type { RegionID } from "../Region.ts";
import { type ListenerAction, serializeActions } from "./common.ts";
import type { LoadBalancer, LoadBalancerArn } from "./LoadBalancer.ts";
import type { TargetGroup, TargetGroupArn } from "./TargetGroup.ts";

export type ListenerArn =
  `arn:aws:elasticloadbalancing:${RegionID}:${AccountID}:listener/${string}`;

export interface ListenerProps {
  /** The load balancer this listener belongs to. Changing it replaces the listener. */
  loadBalancerArn: Input<LoadBalancerArn> | LoadBalancer;
  /**
   * Single forward target group. Convenience sugar that desugars to a single
   * `{ type: "forward" }` default action. Prefer {@link defaultActions} for the
   * full action surface. Mutually exclusive with `defaultActions`.
   */
  targetGroupArn?: Input<TargetGroupArn> | TargetGroup;
  /**
   * The default actions for the listener (forward / redirect / fixedResponse /
   * authenticateOidc / authenticateCognito). Takes precedence over
   * {@link targetGroupArn}.
   */
  defaultActions?: ListenerAction[];
  /** The port on which the load balancer listens. Updated in place. */
  port: number;
  /**
   * The listener protocol.
   * @default "HTTP"
   */
  protocol?: "HTTP" | "HTTPS" | "TCP" | "TLS" | "UDP" | "TCP_UDP";
  /**
   * The default (and any additional SNI) certificate ARNs. The first entry is
   * the default certificate; the rest are attached as SNI certificates.
   * Declarative over the full SNI list: certificates attached out of band
   * (including via standalone `ListenerCertificate` resources) are removed on
   * reconcile. Omit this prop and use `certificateArn` +
   * `ListenerCertificate` attachments to manage SNI certificates
   * independently. Prefer this over the legacy single {@link certificateArn}.
   */
  certificates?: string[];
  /**
   * The default certificate ARN (legacy single-cert form). Folded into
   * {@link certificates} as the default certificate.
   */
  certificateArn?: string;
  /** The security policy that defines supported protocols and ciphers (HTTPS/TLS). */
  sslPolicy?: string;
  /** The ALPN policy for TLS listeners (e.g. `HTTP2Optional`). */
  alpnPolicy?: string[];
  /** Mutual TLS (mTLS) configuration for HTTPS listeners. */
  mutualAuthentication?: {
    /** The mTLS mode. */
    mode: "off" | "passthrough" | "verify";
    /** The trust store ARN. Required when `mode` is `verify`. */
    trustStoreArn?: string;
    /** Whether to ignore expired client certificates. */
    ignoreClientCertificateExpiry?: boolean;
    /** Whether to advertise the trust-store CA names in the TLS handshake. */
    advertiseTrustStoreCaNames?: "on" | "off";
  };
  /**
   * Raw listener attributes, synced via `modifyListenerAttributes` — e.g.
   * `tcp.idle_timeout.seconds` (NLB TCP listeners) or
   * `routing.http.response.server.enabled` (ALB HTTP/HTTPS listeners).
   */
  attributes?: Record<string, string>;
}

export interface Listener extends Resource<
  "AWS.ELBv2.Listener",
  ListenerProps,
  {
    /** The ARN of the listener. */
    listenerArn: ListenerArn;
    /** The ARN of the load balancer the listener is attached to. */
    loadBalancerArn: LoadBalancerArn;
    /** The ARN of the target group from the default forward action, if any. */
    targetGroupArn: TargetGroupArn | undefined;
    /** The port the listener accepts connections on. */
    port: number;
    /** The protocol for connections (e.g. `HTTP`, `HTTPS`, `TCP`, `TLS`). */
    protocol: string;
  },
  never,
  Providers
> {}

/**
 * An ELBv2 (Application/Network) Load Balancer listener. A listener checks for
 * connection requests using its configured protocol and port, then routes them
 * to target groups via its default actions (and any attached
 * {@link ListenerRule}s).
 * @resource
 * @section Creating a Listener
 * @example Basic HTTP forward listener
 * ```typescript
 * const listener = yield* Listener("http", {
 *   loadBalancerArn: lb.loadBalancerArn,
 *   targetGroupArn: tg.targetGroupArn,
 *   port: 80,
 *   protocol: "HTTP",
 * });
 * ```
 *
 * @example HTTPS listener with certificate and SSL policy
 * ```typescript
 * const listener = yield* Listener("https", {
 *   loadBalancerArn: lb.loadBalancerArn,
 *   defaultActions: [
 *     { type: "forward", targetGroups: [{ targetGroupArn: tg.targetGroupArn }] },
 *   ],
 *   port: 443,
 *   protocol: "HTTPS",
 *   certificates: [primaryCertArn, sniCertArn],
 *   sslPolicy: "ELBSecurityPolicy-TLS13-1-2-2021-06",
 * });
 * ```
 *
 * @section Default Actions
 * @example Redirect HTTP to HTTPS
 * ```typescript
 * const redirect = yield* Listener("redirect", {
 *   loadBalancerArn: lb.loadBalancerArn,
 *   defaultActions: [
 *     { type: "redirect", statusCode: "HTTP_301", protocol: "HTTPS", port: "443" },
 *   ],
 *   port: 80,
 *   protocol: "HTTP",
 * });
 * ```
 *
 * @example Fixed response
 * ```typescript
 * const maintenance = yield* Listener("maintenance", {
 *   loadBalancerArn: lb.loadBalancerArn,
 *   defaultActions: [
 *     { type: "fixedResponse", statusCode: "503", contentType: "text/plain", messageBody: "down" },
 *   ],
 *   port: 80,
 * });
 * ```
 *
 * @example Weighted forward with stickiness
 * ```typescript
 * const weighted = yield* Listener("weighted", {
 *   loadBalancerArn: lb.loadBalancerArn,
 *   defaultActions: [
 *     {
 *       type: "forward",
 *       targetGroups: [
 *         { targetGroupArn: blue.targetGroupArn, weight: 90 },
 *         { targetGroupArn: green.targetGroupArn, weight: 10 },
 *       ],
 *       stickiness: { enabled: true, duration: "1 hour" },
 *     },
 *   ],
 *   port: 80,
 * });
 * ```
 *
 * @section Mutual TLS
 * @example mTLS verify mode with a trust store
 * ```typescript
 * const mtls = yield* Listener("mtls", {
 *   loadBalancerArn: lb.loadBalancerArn,
 *   defaultActions: [
 *     { type: "forward", targetGroups: [{ targetGroupArn: tg.targetGroupArn }] },
 *   ],
 *   port: 443,
 *   protocol: "HTTPS",
 *   certificates: [certArn],
 *   mutualAuthentication: { mode: "verify", trustStoreArn: trustStore.trustStoreArn },
 * });
 * ```
 */
export const Listener = Resource<Listener>("AWS.ELBv2.Listener");

// Build the default-action wire shape from desugared props.
const desiredDefaultActions = (props: ListenerProps): elbv2.Action[] => {
  if (props.defaultActions && props.defaultActions.length > 0) {
    return serializeActions(props.defaultActions);
  }
  if (props.targetGroupArn) {
    return serializeActions([
      {
        type: "forward",
        targetGroups: [
          { targetGroupArn: props.targetGroupArn as TargetGroupArn },
        ],
      },
    ]);
  }
  return [];
};

// The default forward target group (if any) for the Attributes shape.
const defaultForwardTargetGroup = (
  actions: elbv2.Action[] | undefined,
): TargetGroupArn | undefined => {
  const forward = (actions ?? []).find((a) => a.Type === "forward");
  return (forward?.TargetGroupArn ??
    forward?.ForwardConfig?.TargetGroups?.[0]?.TargetGroupArn) as
    | TargetGroupArn
    | undefined;
};

// Build certificate list: first = default, the rest are SNI extras.
const desiredCertificates = (props: ListenerProps): string[] => {
  if (props.certificates && props.certificates.length > 0) {
    return props.certificates;
  }
  return props.certificateArn ? [props.certificateArn] : [];
};

const desiredMutualAuth = (
  props: ListenerProps,
): elbv2.MutualAuthenticationAttributes | undefined =>
  props.mutualAuthentication
    ? {
        Mode: props.mutualAuthentication.mode,
        TrustStoreArn: props.mutualAuthentication.trustStoreArn,
        IgnoreClientCertificateExpiry:
          props.mutualAuthentication.ignoreClientCertificateExpiry,
        AdvertiseTrustStoreCaNames:
          props.mutualAuthentication.advertiseTrustStoreCaNames,
      }
    : undefined;

export const ListenerProvider = () =>
  Provider.succeed(Listener, {
    stables: ["listenerArn", "loadBalancerArn"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return;
      if (olds.loadBalancerArn !== news.loadBalancerArn) {
        return { action: "replace" } as const;
      }
    }),
    read: Effect.fn(function* ({ output }) {
      if (!output) {
        return undefined;
      }
      const described = yield* elbv2
        .describeListeners({
          ListenerArns: [output.listenerArn],
        })
        .pipe(
          Effect.catchTag("ListenerNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      const listener = described?.Listeners?.[0];
      if (!listener?.ListenerArn) {
        return undefined;
      }
      return {
        listenerArn: listener.ListenerArn as ListenerArn,
        loadBalancerArn: listener.LoadBalancerArn as LoadBalancerArn,
        targetGroupArn:
          defaultForwardTargetGroup(listener.DefaultActions) ??
          output.targetGroupArn,
        port: listener.Port!,
        protocol: listener.Protocol!,
      };
    }),
    // Listeners belong to a load balancer; describeListeners requires a
    // LoadBalancerArn. Enumerate every load balancer first, then exhaustively
    // page listeners per LB with bounded concurrency.
    list: Effect.fn(function* () {
      const loadBalancerArns = yield* elbv2.describeLoadBalancers
        .pages({})
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) =>
              (page.LoadBalancers ?? []).flatMap((lb) =>
                lb.LoadBalancerArn ? [lb.LoadBalancerArn] : [],
              ),
            ),
          ),
        );
      const rows = yield* Effect.forEach(
        loadBalancerArns,
        (loadBalancerArn) =>
          elbv2.describeListeners
            .pages({ LoadBalancerArn: loadBalancerArn })
            .pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.Listeners ?? [])
                    .filter(
                      (l): l is typeof l & { ListenerArn: string } =>
                        l.ListenerArn != null,
                    )
                    .map((listener) => ({
                      listenerArn: listener.ListenerArn as ListenerArn,
                      loadBalancerArn:
                        listener.LoadBalancerArn as LoadBalancerArn,
                      targetGroupArn: defaultForwardTargetGroup(
                        listener.DefaultActions,
                      ),
                      port: listener.Port!,
                      protocol: listener.Protocol!,
                    })),
                ),
              ),
              // The LB may vanish between enumeration and per-LB listing.
              Effect.catchTag("LoadBalancerNotFoundException", () =>
                Effect.succeed([]),
              ),
              Effect.catchTag("ListenerNotFoundException", () =>
                Effect.succeed([]),
              ),
            ),
        { concurrency: 10 },
      );
      const result: Listener["Attributes"][] = rows.flat();
      return result;
    }),
    reconcile: Effect.fn(function* ({ news, output, session }) {
      const loadBalancerArn = news.loadBalancerArn as LoadBalancerArn;
      const desiredProtocol = news.protocol ?? "HTTP";
      const defaultActions = desiredDefaultActions(news);
      const certs = desiredCertificates(news);
      const mutualAuthentication = desiredMutualAuth(news);

      // Observe — describe the listener if we have a prior ARN; otherwise
      // list listeners on the load balancer and find one matching port.
      let listener: elbv2.Listener | undefined;
      if (output?.listenerArn) {
        const described = yield* elbv2
          .describeListeners({
            ListenerArns: [output.listenerArn],
          })
          .pipe(
            Effect.catchTag("ListenerNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        listener = described?.Listeners?.[0];
      }
      if (!listener?.ListenerArn) {
        const listed = yield* elbv2
          .describeListeners({
            LoadBalancerArn: loadBalancerArn,
          })
          .pipe(
            Effect.catchTag("LoadBalancerNotFoundException", () =>
              Effect.succeed(undefined),
            ),
            Effect.catchTag("ListenerNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        listener = listed?.Listeners?.find((l) => l.Port === news.port);
      }

      // Ensure — create if missing. The first certificate is the default.
      if (!listener?.ListenerArn) {
        const created = yield* elbv2.createListener({
          LoadBalancerArn: loadBalancerArn,
          Port: news.port,
          Protocol: desiredProtocol,
          Certificates:
            certs.length > 0 ? [{ CertificateArn: certs[0] }] : undefined,
          SslPolicy: news.sslPolicy,
          AlpnPolicy: news.alpnPolicy,
          MutualAuthentication: mutualAuthentication,
          DefaultActions: defaultActions,
        });
        listener = created.Listeners?.[0];
        if (!listener?.ListenerArn) {
          return yield* Effect.die(
            new Error("createListener returned no listener"),
          );
        }
      } else {
        // Sync — modifyListener fully replaces these mutable fields.
        const modified = yield* elbv2.modifyListener({
          ListenerArn: listener.ListenerArn,
          Port: news.port,
          Protocol: desiredProtocol,
          Certificates:
            certs.length > 0 ? [{ CertificateArn: certs[0] }] : undefined,
          SslPolicy: news.sslPolicy,
          AlpnPolicy: news.alpnPolicy,
          MutualAuthentication: mutualAuthentication,
          DefaultActions: defaultActions,
        });
        listener = modified.Listeners?.[0] ?? listener;
      }

      const listenerArn = listener.ListenerArn!;

      // Sync attributes — always apply when desired attrs are non-empty; AWS
      // rejects an empty list anyway (same convention as LoadBalancer and
      // TargetGroup attributes).
      if (news.attributes && Object.keys(news.attributes).length > 0) {
        yield* elbv2.modifyListenerAttributes({
          ListenerArn: listenerArn,
          Attributes: Object.entries(news.attributes).map(([Key, Value]) => ({
            Key,
            Value,
          })),
        });
      }

      // Sync additional SNI certificates — observed ↔ desired. The default
      // certificate (certs[0]) is carried by modifyListener and is excluded
      // from the SNI set. Only the explicit plural `certificates` prop is
      // declarative over the FULL list: pruning is skipped otherwise so that
      // standalone `ListenerCertificate` attachments (managed outside this
      // resource) are not torn off on every reconcile.
      if (news.certificates !== undefined) {
        const desiredSni = new Set(certs.slice(1));
        const observedCerts = yield* elbv2
          .describeListenerCertificates({ ListenerArn: listenerArn })
          .pipe(
            Effect.catchTag("ListenerNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        const observedSni = (observedCerts?.Certificates ?? [])
          .filter((c) => !c.IsDefault && c.CertificateArn)
          .map((c) => c.CertificateArn!);
        const toAdd = [...desiredSni].filter(
          (arn) => !observedSni.includes(arn),
        );
        const toRemove = observedSni.filter((arn) => !desiredSni.has(arn));
        if (toAdd.length > 0) {
          yield* elbv2.addListenerCertificates({
            ListenerArn: listenerArn,
            Certificates: toAdd.map((arn) => ({ CertificateArn: arn })),
          });
        }
        if (toRemove.length > 0) {
          yield* elbv2.removeListenerCertificates({
            ListenerArn: listenerArn,
            Certificates: toRemove.map((arn) => ({ CertificateArn: arn })),
          });
        }
      }

      yield* session.note(listenerArn);
      return {
        listenerArn: listenerArn as ListenerArn,
        loadBalancerArn: listener.LoadBalancerArn as LoadBalancerArn,
        targetGroupArn: defaultForwardTargetGroup(defaultActions),
        port: listener.Port ?? news.port,
        protocol: listener.Protocol ?? desiredProtocol,
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* elbv2
        .deleteListener({
          ListenerArn: output.listenerArn,
        })
        .pipe(Effect.catchTag("ListenerNotFoundException", () => Effect.void));
    }),
  });
