import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import { isResolved } from "alchemy/Diff";
import type { Input } from "alchemy/Input";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { AccountID } from "../Environment.ts";
import { plainJson } from "../internal/Observe.ts";
import type { Providers } from "../Providers.ts";
import type { RegionID } from "../Region.ts";
import {
  attributeDelta,
  type ListenerAction,
  observedAttributes,
  serializeActions,
} from "./common.ts";
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
    /**
     * The live values of the keys declared in `attributes`. Undeclared
     * attributes are left out so AWS defaults never register as drift.
     */
    attributes?: Record<string, string>;
    /**
     * Default actions, default certificate, TLS/ALPN policy, mutual TLS and
     * (when `certificates` is declared) the SNI certificates, as observed.
     * Lets `alchemy drift` detect out-of-band changes.
     */
    configuration?: {
      defaultActions: unknown[];
      certificateArn?: string;
      sslPolicy?: string;
      alpnPolicy?: string[];
      mutualAuthentication?: unknown;
      sniCertificateArns?: string[];
    };
  },
  never,
  Providers
> {}

/**
 * An ELBv2 (Application/Network) Load Balancer listener. A listener checks for
 * connection requests using its configured protocol and port, then routes them
 * to target groups via its default actions (and any attached
 * {@link ListenerRule}s).
 * ### Creating a Listener
 * **Example:** Basic HTTP forward listener
 * ```typescript
 * const listener = yield* Listener("http", {
 *   loadBalancerArn: lb.loadBalancerArn,
 *   targetGroupArn: tg.targetGroupArn,
 *   port: 80,
 *   protocol: "HTTP",
 * });
 * ```
 *
 * **Example:** HTTPS listener with certificate and SSL policy
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
 * ### Default Actions
 * **Example:** Redirect HTTP to HTTPS
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
 * **Example:** Fixed response
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
 * **Example:** Weighted forward with stickiness
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
 * ### Mutual TLS
 * **Example:** mTLS verify mode with a trust store
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
 *
 * @resource
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
        targetGroups: [{ targetGroupArn: props.targetGroupArn as TargetGroupArn }],
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
  return (forward?.TargetGroupArn ?? forward?.ForwardConfig?.TargetGroups?.[0]?.TargetGroupArn) as
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
        IgnoreClientCertificateExpiry: props.mutualAuthentication.ignoreClientCertificateExpiry,
        AdvertiseTrustStoreCaNames: props.mutualAuthentication.advertiseTrustStoreCaNames,
      }
    : undefined;

// The observed values of the declared attribute keys; skips the call when
// nothing is declared.
const readListenerAttributes = Effect.fn(function* (
  listenerArn: string,
  declared: Record<string, string> | undefined,
) {
  if (!declared || Object.keys(declared).length === 0) return undefined;
  const observed = yield* elbv2.describeListenerAttributes({ ListenerArn: listenerArn });
  return observedAttributes(declared, observed.Attributes);
});

/**
 * The configuration `read` and `reconcile` both report, so a converged
 * listener reads unchanged.
 */
const observeListenerConfiguration = (
  listener: elbv2.Listener,
  sniCertificateArns: string[] | undefined,
): NonNullable<Listener["Attributes"]["configuration"]> =>
  plainJson({
    defaultActions: [...(listener.DefaultActions ?? [])].sort(
      (a, b) => (a.Order ?? 0) - (b.Order ?? 0),
    ),
    certificateArn: listener.Certificates?.[0]?.CertificateArn,
    sslPolicy: listener.SslPolicy,
    alpnPolicy: listener.AlpnPolicy?.length ? listener.AlpnPolicy : undefined,
    mutualAuthentication: listener.MutualAuthentication,
    sniCertificateArns: sniCertificateArns && [...sniCertificateArns].sort(),
  });

// The non-default certificates on a listener; only observed when the props
// declare the full `certificates` list.
const readSniCertificates = Effect.fn(function* (
  listenerArn: string,
  props: ListenerProps | undefined,
) {
  if (props?.certificates === undefined) return undefined;
  const observed = yield* elbv2.describeListenerCertificates({ ListenerArn: listenerArn });
  return (observed.Certificates ?? []).flatMap((c) =>
    !c.IsDefault && c.CertificateArn ? [c.CertificateArn] : [],
  );
});

export const ListenerProvider = () =>
  Provider.succeed(Listener, {
    stables: ["listenerArn", "loadBalancerArn"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return;
      if (olds.loadBalancerArn !== news.loadBalancerArn) {
        return { action: "replace" } as const;
      }
    }),
    read: Effect.fn(function* ({ olds, output }) {
      if (!output) {
        return undefined;
      }
      const described = yield* elbv2
        .describeListeners({
          ListenerArns: [output.listenerArn],
        })
        .pipe(Effect.catchTag("ListenerNotFoundException", () => Effect.undefined));
      const listener = described?.Listeners?.[0];
      if (!listener?.ListenerArn) {
        return undefined;
      }
      const attributes = yield* readListenerAttributes(output.listenerArn, olds?.attributes).pipe(
        Effect.catchTag("ListenerNotFoundException", () => Effect.succeed(null)),
      );
      if (attributes === null) {
        return undefined;
      }
      const sni = yield* readSniCertificates(output.listenerArn, olds).pipe(
        Effect.catchTag("ListenerNotFoundException", () => Effect.succeed(null)),
      );
      if (sni === null) {
        return undefined;
      }
      return {
        listenerArn: listener.ListenerArn as ListenerArn,
        loadBalancerArn: listener.LoadBalancerArn as LoadBalancerArn,
        targetGroupArn: defaultForwardTargetGroup(listener.DefaultActions) ?? output.targetGroupArn,
        port: listener.Port!,
        protocol: listener.Protocol!,
        attributes,
        configuration: observeListenerConfiguration(listener, sni),
      };
    }),
    // Listeners belong to a load balancer; describeListeners requires a
    // LoadBalancerArn. Enumerate every load balancer first, then exhaustively
    // page listeners per LB with bounded concurrency.
    list: Effect.fn(function* () {
      const loadBalancerArns = yield* elbv2.describeLoadBalancers.pages({}).pipe(
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
          elbv2.describeListeners.pages({ LoadBalancerArn: loadBalancerArn }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.Listeners ?? [])
                  .filter((l): l is typeof l & { ListenerArn: string } => l.ListenerArn != null)
                  .map((listener) => ({
                    listenerArn: listener.ListenerArn as ListenerArn,
                    loadBalancerArn: listener.LoadBalancerArn as LoadBalancerArn,
                    targetGroupArn: defaultForwardTargetGroup(listener.DefaultActions),
                    port: listener.Port!,
                    protocol: listener.Protocol!,
                  })),
              ),
            ),
            // The LB may vanish between enumeration and per-LB listing.
            Effect.catchTags({
              LoadBalancerNotFoundException: () => Effect.succeed([]),
              ListenerNotFoundException: () => Effect.succeed([]),
            }),
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
          .pipe(Effect.catchTag("ListenerNotFoundException", () => Effect.undefined));
        listener = described?.Listeners?.[0];
      }
      if (!listener?.ListenerArn) {
        const listed = yield* elbv2
          .describeListeners({
            LoadBalancerArn: loadBalancerArn,
          })
          .pipe(
            Effect.catchTags({
              LoadBalancerNotFoundException: () => Effect.undefined,
              ListenerNotFoundException: () => Effect.undefined,
            }),
          );
        listener = listed?.Listeners?.find((l) => l.Port === news.port);
      }

      // Ensure — create if missing. The first certificate is the default.
      if (!listener?.ListenerArn) {
        const created = yield* elbv2.createListener({
          LoadBalancerArn: loadBalancerArn,
          Port: news.port,
          Protocol: desiredProtocol,
          Certificates: certs.length > 0 ? [{ CertificateArn: certs[0] }] : undefined,
          SslPolicy: news.sslPolicy,
          AlpnPolicy: news.alpnPolicy,
          MutualAuthentication: mutualAuthentication,
          DefaultActions: defaultActions,
        });
        listener = created.Listeners?.[0];
        if (!listener?.ListenerArn) {
          return yield* Effect.die(new Error("createListener returned no listener"));
        }
      } else {
        // Sync — modifyListener fully replaces these mutable fields.
        const modified = yield* elbv2.modifyListener({
          ListenerArn: listener.ListenerArn,
          Port: news.port,
          Protocol: desiredProtocol,
          Certificates: certs.length > 0 ? [{ CertificateArn: certs[0] }] : undefined,
          SslPolicy: news.sslPolicy,
          AlpnPolicy: news.alpnPolicy,
          MutualAuthentication: mutualAuthentication,
          DefaultActions: defaultActions,
        });
        listener = modified.Listeners?.[0] ?? listener;
      }

      const listenerArn = listener.ListenerArn!;

      // Sync attributes — diff the observed values of the declared keys
      // against desired and apply only the delta.
      let attributes = yield* readListenerAttributes(listenerArn, news.attributes);
      const attributeChanges = attributeDelta(news.attributes, attributes);
      if (attributeChanges.length > 0) {
        const modified = yield* elbv2.modifyListenerAttributes({
          ListenerArn: listenerArn,
          Attributes: attributeChanges,
        });
        attributes = {
          ...attributes,
          ...observedAttributes(news.attributes, modified.Attributes),
        };
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
          .pipe(Effect.catchTag("ListenerNotFoundException", () => Effect.undefined));
        const observedSni = (observedCerts?.Certificates ?? [])
          .filter((c) => !c.IsDefault && c.CertificateArn)
          .map((c) => c.CertificateArn!);
        const toAdd = [...desiredSni].filter((arn) => !observedSni.includes(arn));
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
        attributes,
        configuration: observeListenerConfiguration(
          listener,
          news.certificates === undefined ? undefined : certs.slice(1),
        ),
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
