import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import type { Listener, ListenerArn } from "./Listener.ts";

export interface ListenerCertificateProps {
  /** The HTTPS/TLS listener to attach the certificate to. Changing it replaces the attachment. */
  listenerArn: Input<ListenerArn> | Listener;
  /** The ARN of the ACM (or IAM) certificate to add to the listener's SNI certificate list. Changing it replaces the attachment. */
  certificateArn: string;
}

export interface ListenerCertificate extends Resource<
  "AWS.ELBv2.ListenerCertificate",
  ListenerCertificateProps,
  {
    /** The ARN of the listener the certificate is attached to. */
    listenerArn: ListenerArn;
    /** The ARN of the ACM/IAM certificate. */
    certificateArn: string;
  },
  never,
  Providers
> {}

/**
 * Attaches an additional SNI certificate to an ELBv2 HTTPS/TLS listener. The
 * listener's default certificate is configured on the {@link Listener} itself;
 * `ListenerCertificate` adds extra certificates that the load balancer selects
 * via Server Name Indication (SNI) based on the requested hostname.
 *
 * Use this resource when the certificates are managed independently of the
 * listener (e.g. one certificate per tenant domain). When the full certificate
 * list is known up front, prefer the listener's `certificates` prop, which
 * declaratively syncs the whole set.
 * @resource
 * @section Attaching Certificates
 * @example Additional SNI certificate
 * ```typescript
 * const listener = yield* Listener("https", {
 *   loadBalancerArn: lb.loadBalancerArn,
 *   targetGroupArn: tg.targetGroupArn,
 *   port: 443,
 *   protocol: "HTTPS",
 *   certificateArn: defaultCertArn,
 * });
 * yield* ListenerCertificate("tenant-cert", {
 *   listenerArn: listener.listenerArn,
 *   certificateArn: tenantCertArn,
 * });
 * ```
 */
export const ListenerCertificate = Resource<ListenerCertificate>(
  "AWS.ELBv2.ListenerCertificate",
);

export const ListenerCertificateProvider = () =>
  Provider.succeed(ListenerCertificate, {
    stables: ["listenerArn", "certificateArn"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return;
      // Existence-only resource — both identity props force replacement.
      if (
        olds.listenerArn !== news.listenerArn ||
        olds.certificateArn !== news.certificateArn
      ) {
        return { action: "replace" } as const;
      }
    }),
    read: Effect.fn(function* ({ output }) {
      if (!output) {
        return undefined;
      }
      const attached = yield* elbv2.describeListenerCertificates
        .items({ ListenerArn: output.listenerArn })
        .pipe(
          Stream.filter(
            (c) => !c.IsDefault && c.CertificateArn === output.certificateArn,
          ),
          Stream.runHead,
          Effect.map(Option.isSome),
          Effect.catchTag("ListenerNotFoundException", () =>
            Effect.succeed(false),
          ),
        );
      return attached ? output : undefined;
    }),
    // Certificates belong to a listener, which belongs to a load balancer.
    // Enumerate every load balancer, then every listener, then every
    // non-default certificate.
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
      const listenerArns = yield* Effect.forEach(
        loadBalancerArns,
        (loadBalancerArn) =>
          elbv2.describeListeners
            .pages({ LoadBalancerArn: loadBalancerArn })
            .pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.Listeners ?? []).flatMap((l) =>
                    l.ListenerArn ? [l.ListenerArn as ListenerArn] : [],
                  ),
                ),
              ),
              Effect.catchTag("LoadBalancerNotFoundException", () =>
                Effect.succeed([]),
              ),
              Effect.catchTag("ListenerNotFoundException", () =>
                Effect.succeed([]),
              ),
            ),
        { concurrency: 10 },
      );
      const rows = yield* Effect.forEach(
        listenerArns.flat(),
        (listenerArn) =>
          elbv2.describeListenerCertificates
            .items({ ListenerArn: listenerArn })
            .pipe(
              Stream.filter((c) => !c.IsDefault && c.CertificateArn != null),
              Stream.map((c) => ({
                listenerArn,
                certificateArn: c.CertificateArn!,
              })),
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk)),
              Effect.catchTag("ListenerNotFoundException", () =>
                Effect.succeed([]),
              ),
            ),
        { concurrency: 10 },
      );
      const result: ListenerCertificate["Attributes"][] = rows.flat();
      return result;
    }),
    reconcile: Effect.fn(function* ({ news, session }) {
      const listenerArn = news.listenerArn as ListenerArn;

      // Observe — is the certificate already attached?
      const attached = yield* elbv2.describeListenerCertificates
        .items({ ListenerArn: listenerArn })
        .pipe(
          Stream.filter(
            (c) => !c.IsDefault && c.CertificateArn === news.certificateArn,
          ),
          Stream.runHead,
          Effect.map(Option.isSome),
        );

      // Ensure — the API is an idempotent add, but skip the call on no-op.
      if (!attached) {
        yield* elbv2.addListenerCertificates({
          ListenerArn: listenerArn,
          Certificates: [{ CertificateArn: news.certificateArn }],
        });
      }

      yield* session.note(`${news.certificateArn} -> ${listenerArn}`);
      return {
        listenerArn,
        certificateArn: news.certificateArn,
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* elbv2
        .removeListenerCertificates({
          ListenerArn: output.listenerArn,
          Certificates: [{ CertificateArn: output.certificateArn }],
        })
        .pipe(
          // Listener already deleted (removing a certificate that is not in
          // the list succeeds, so no certificate-level catch is needed).
          Effect.catchTag("ListenerNotFoundException", () => Effect.void),
        );
    }),
  });
