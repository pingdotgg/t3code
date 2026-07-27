import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload AWS Private CA delivers to EventBridge. Success
 * events (certificate issued, certificate revoked, CRL generated, audit
 * report created) carry no detail — the CA ARN and the certificate/report
 * ARN ride in the event's top-level `resources` array. Failure events
 * (e.g. a CRL that could not be written to S3) describe the failure here.
 */
export interface CertificateAuthorityEventDetail {
  /** Failure events: `"failure"`. Absent on success events. */
  result?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** An AWS Private CA EventBridge event delivered to the handler. */
export type CertificateAuthorityEvent =
  EventRecord<CertificateAuthorityEventDetail>;

/** Which AWS Private CA notifications to subscribe to. */
export type CertificateAuthorityEventKind =
  | "issuance"
  | "revocation"
  | "crl"
  | "auditReport";

const DETAIL_TYPES: Record<CertificateAuthorityEventKind, string> = {
  issuance: "ACM Private CA Certificate Issuance",
  revocation: "ACM Private CA Certificate Revocation",
  crl: "ACM Private CA CRL Generation",
  auditReport: "ACM Private CA Audit Report Generation",
};

export interface CertificateAuthorityEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "ACMPCAEvents"
   */
  id?: string;
  /**
   * Which notifications to subscribe to: certificate issuance, certificate
   * revocation, CRL generation, audit report generation, or any subset.
   * @default ["issuance"]
   */
  kinds?: readonly CertificateAuthorityEventKind[];
  /**
   * Restrict to events about specific CAs (matched against the event's
   * top-level `resources`, which always includes the CA's ARN).
   */
  certificateAuthorityArns?: readonly string[];
}

/**
 * Event source connecting AWS Private CA notifications to the hosting
 * compute. AWS Private CA publishes certificate issuance/revocation, CRL
 * generation, and audit report completion to the account's default
 * EventBridge bus (source `aws.acm-pca`); this subscribes the host Function
 * to those events so it can distribute freshly issued certificates, alert
 * on revocations, or track CRL/audit failures.
 *
 * AWS Private CA publishes to EventBridge automatically — no additional
 * resource is created besides the EventBridge rule targeting the host.
 * Provide the host-specific implementation layer (e.g.
 * `AWS.Lambda.EventSource`) on the Function effect.
 *
 * Success events carry the CA ARN and the certificate (or audit report)
 * ARN in the event's top-level `resources` array; `detail` is empty.
 * Failure events set `detail.result` to `"failure"`.
 *
 * @section Consuming Certificate Authority Events
 * @example React To Issued Certificates
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default CertFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.ACMPCA.consumeCertificateAuthorityEvents(
 *       { kinds: ["issuance", "revocation"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           Effect.log(`${event["detail-type"]}: ${event.resources[1]}`),
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeCertificateAuthorityEvents = <
  StreamReq = never,
  Req = never,
>(
  props: CertificateAuthorityEventSourceProps,
  process: (
    events: Stream.Stream<CertificateAuthorityEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "ACMPCAEvents",
    {
      source: ["aws.acm-pca"],
      "detail-type": (props.kinds ?? (["issuance"] as const)).map(
        (kind) => DETAIL_TYPES[kind],
      ),
      ...(props.certificateAuthorityArns !== undefined
        ? { resources: [...props.certificateAuthorityArns] }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
