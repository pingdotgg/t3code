import * as dns from "@distilled.cloud/cloudflare/dns";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import { propagationDelay, waitForTxt } from "../../ACME/Dns.ts";
import {
  dnsSolverLayer,
  type DnsChallengeRecord,
  type DnsSolver,
  type DnsSolverDescriptor,
} from "../../ACME/DnsSolver.ts";
import { DnsSolverError } from "../../ACME/Errors.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Credentials } from "../Credentials.ts";
import type { Input } from "../../Input.ts";
import type { WriteDnsClient } from "./WriteDns.ts";

/** Solver descriptor: publish `_acme-challenge` TXT records in a Cloudflare zone. */
export interface CloudflareDnsSolver extends DnsSolverDescriptor {
  readonly type: "Cloudflare.DNS";
  readonly zoneId: string;
}

/**
 * DNS-01 through a Cloudflare zone's records, for `ACME.Certificate`.
 * The implementation is registered by `Cloudflare.providers()`.
 *
 * **Example:**
 * ```typescript
 * const account = yield* LetsEncrypt;
 * const zone = yield* Zone;
 * const wildcard = yield* ACME.Certificate("Wildcard", {
 *   account,
 *   identifiers: ["*.example.com"],
 *   solver: Cloudflare.DNS.AcmeSolver(zone),
 * });
 * ```
 */
export const AcmeSolver = <ZoneId extends Input<string>>(zone: {
  readonly zoneId: ZoneId;
}) => ({
  type: "Cloudflare.DNS" as const,
  zoneId: zone.zoneId,
});

const CHALLENGE_TTL = 60;
/** Post-publish wait for the in-Worker solver. */
const RUNTIME_PROPAGATION_DELAY = "60 seconds";

const unquote = (content: string | null | undefined): string =>
  (content ?? "").replace(/^"|"$/g, "");

const solverError = (message: string) => (cause: unknown) =>
  new DnsSolverError({ message, cause });

/** Deploy-time solver over the distilled DNS SDK (zone id fixed). */
export const makeCloudflareDnsSolver = (
  zoneId: string,
): DnsSolver<Credentials | HttpClient.HttpClient> => {
  const matching = (record: DnsChallengeRecord) =>
    dns.listRecords
      .items({ zoneId, name: { exact: record.fqdn }, type: "TXT" })
      .pipe(
        Stream.filter(
          (r) => r.name === record.fqdn && unquote(r.content) === record.value,
        ),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
      );
  return {
    present: (record) =>
      Effect.gen(function* () {
        const existing = yield* matching(record);
        if (existing.length > 0) return;
        yield* dns.createRecord({
          zoneId,
          type: "TXT",
          name: record.fqdn,
          content: record.value,
          ttl: CHALLENGE_TTL,
        });
      }).pipe(
        Effect.mapError(solverError(`Could not publish TXT ${record.fqdn}`)),
      ),
    cleanup: (record) =>
      Effect.gen(function* () {
        const existing = yield* matching(record);
        yield* Effect.forEach(existing, (r) =>
          dns.deleteRecord({ zoneId, dnsRecordId: r.id }),
        );
      }).pipe(
        Effect.mapError(solverError(`Could not remove TXT ${record.fqdn}`)),
      ),
    // Let Cloudflare publish before any intercepted/recursive lookup can cache
    // a negative answer for the zone's SOA minimum (often 30 minutes).
    propagated: (record, options) =>
      waitForTxt(record.fqdn, record.value, {
        ...options,
        initialDelay: options.initialDelay ?? "60 seconds",
        timeout: options.timeout ?? "90 seconds",
      }),
  };
};

/**
 * Registers the `Cloudflare.DNS` solver type with the ACME provider,
 * capturing the Cloudflare credentials from the providers layer.
 */
export const AcmeDnsSolverLive = dnsSolverLayer(
  "Cloudflare.DNS",
  (descriptor) =>
    typeof descriptor.zoneId === "string" && descriptor.zoneId.length > 0
      ? Effect.succeed(makeCloudflareDnsSolver(descriptor.zoneId))
      : Effect.fail(
          new DnsSolverError({
            message: "Cloudflare DNS solver requires a zoneId.",
          }),
        ),
).pipe(Layer.provide(FetchHttpClient.layer));

/**
 * Runtime solver over a bound {@link WriteDnsClient}, for
 * `ACME.IssueCertificate` inside a Worker or Service.
 *
 * **Example:**
 * ```typescript
 * const dns = yield* Cloudflare.DNS.WriteDns(Zone);
 * const issued = yield* acme.issue({
 *   identifiers: ["*.tenant.example.com"],
 *   solver: Cloudflare.DNS.acmeDnsSolver(dns),
 * });
 * ```
 */
export const acmeDnsSolver = (
  client: WriteDnsClient,
): DnsSolver<RuntimeContext> => {
  const published = new Map<string, string>();
  const keyOf = (record: DnsChallengeRecord) =>
    `${record.fqdn}|${record.value}`;
  return {
    present: (record) =>
      client
        .createDnsRecord({
          type: "TXT",
          name: record.fqdn,
          content: record.value,
          ttl: CHALLENGE_TTL,
        })
        .pipe(
          Effect.tap((created) =>
            Effect.sync(() => published.set(keyOf(record), created.id)),
          ),
          Effect.asVoid,
          Effect.mapError(solverError(`Could not publish TXT ${record.fqdn}`)),
        ),
    cleanup: (record) =>
      Effect.suspend(() => {
        const id = published.get(keyOf(record));
        if (id === undefined) return Effect.void;
        return client.deleteDnsRecord(id).pipe(
          Effect.tap(() => Effect.sync(() => published.delete(keyOf(record)))),
          Effect.asVoid,
          Effect.mapError(solverError(`Could not remove TXT ${record.fqdn}`)),
        );
      }),
    // Inside a Worker there is no authoritative lookup and public DoH
    // resolvers cache stale sets; Cloudflare's edge serves a new record
    // within seconds, so a fixed wait is the reliable choice here.
    propagated: (_record, options) =>
      propagationDelay({ delay: options.delay ?? RUNTIME_PROPAGATION_DELAY }),
  };
};
