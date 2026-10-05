/**
 * DNS-01 solvers: how the ACME flow publishes `_acme-challenge` TXT
 * records.
 *
 * A solver has two forms:
 *
 * - a **descriptor** — plain, serializable data in a resource's props
 *   (`{ type: "Cloudflare.DNS", zoneId }`) that survives state and the RPC
 *   boundary. Each DNS provider contributes a constructor
 *   (`Cloudflare.DNS.AcmeSolver(zone)`) and registers the matching
 *   implementation from its `providers()` layer, so the ACME provider
 *   never imports a DNS SDK itself.
 * - a **runtime solver** — the {@link DnsSolver} interface a running
 *   Worker or Service hands to `IssueCertificate.issue`, built from a
 *   runtime DNS write client (`Cloudflare.DNS.acmeDnsSolver(dns)`).
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as HttpClient from "effect/http/HttpClient";
import type { PropagationOptions } from "./Dns.ts";
import {
  DnsSolverNotRegistered,
  type DnsPropagationTimeout,
  type DnsSolverError,
} from "./Errors.ts";

/** A challenge record to publish: the `_acme-challenge.<name>` FQDN and its TXT value. */
export interface DnsChallengeRecord {
  readonly fqdn: string;
  readonly value: string;
}

/** Runtime DNS-01 solver. `R` is whatever context the underlying client needs. */
export interface DnsSolver<R = never> {
  /** Publish `value` as a TXT record at `fqdn`. Idempotent. */
  readonly present: (
    record: DnsChallengeRecord,
  ) => Effect.Effect<void, DnsSolverError, R>;
  /** Remove the record published by `present`. Idempotent; runs in a finalizer. */
  readonly cleanup: (
    record: DnsChallengeRecord,
  ) => Effect.Effect<void, DnsSolverError, R>;
  /**
   * Wait until the record is visible. Defaults to polling public DNS over
   * HTTPS; a solver for a private DNS (tests, split-horizon zones) overrides it.
   */
  readonly propagated?:
    | ((
        record: DnsChallengeRecord,
        options: PropagationOptions,
      ) => Effect.Effect<
        void,
        DnsSolverError | DnsPropagationTimeout,
        R | HttpClient.HttpClient
      >)
    | undefined;
}

/**
 * Serializable solver description stored in `ACME.Certificate` props.
 * `type` selects the registered implementation; the rest is provider data.
 */
export interface DnsSolverDescriptor {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** Builds a runtime solver from a descriptor at reconcile time. */
export type DnsSolverFactory = (
  descriptor: DnsSolverDescriptor,
) => Effect.Effect<DnsSolver, DnsSolverError>;

const solverService = (type: string) =>
  Context.Service<DnsSolverFactory>(`alchemy/ACME/DnsSolver/${type}`);

/** Resolve the registered implementation for a descriptor. */
export const resolveDnsSolver = (
  descriptor: DnsSolverDescriptor,
): Effect.Effect<DnsSolver, DnsSolverNotRegistered | DnsSolverError> =>
  Effect.gen(function* () {
    const factory = yield* Effect.serviceOption(solverService(descriptor.type));
    if (Option.isNone(factory)) {
      return yield* new DnsSolverNotRegistered({ type: descriptor.type });
    }
    return yield* factory.value(descriptor);
  });

/** A solver whose methods run with `context` provided (drops `R`). */
export const provideSolver = <R>(
  solver: DnsSolver<R>,
  context: Context.Context<R>,
): DnsSolver => ({
  present: (record) =>
    solver.present(record).pipe(Effect.provideContext(context)),
  cleanup: (record) =>
    solver.cleanup(record).pipe(Effect.provideContext(context)),
  propagated:
    solver.propagated === undefined
      ? undefined
      : (record, options) =>
          solver.propagated!(record, options).pipe(
            Effect.provideContext(context),
          ),
});

/**
 * Register a solver implementation from a `providers()` layer, capturing
 * whatever services `R` the solver needs from that layer's own context so
 * the ACME provider can run it without knowing about the DNS provider.
 */
export const dnsSolverLayer = <R>(
  type: string,
  make: (
    descriptor: DnsSolverDescriptor,
  ) => Effect.Effect<DnsSolver<R>, DnsSolverError>,
): Layer.Layer<DnsSolverFactory, never, R> =>
  Layer.effect(
    solverService(type),
    Effect.gen(function* () {
      const context = yield* Effect.context<R>();
      return (descriptor: DnsSolverDescriptor) =>
        make(descriptor).pipe(
          Effect.map((solver) => provideSolver(solver, context)),
        );
    }),
  );
