// @effect-diagnostics effectFnOpportunity:off globalDate:off globalDateInEffect:off globalJsonInEffect:off runEffectInsideEffect:off nodeBuiltinImport:off - Thin wrapper over promise-based cores; spans come from withSpan, and wall-clock timestamps are user-facing state.
import {
  ORCHESTRATION_PROTOCOL_VERSION,
  type MobileAccessStatus,
  type MobileConnectionAttempt,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

/**
 * Remembers recent phone connections the host refused, so Settings → Mobile Access can say why a
 * phone cannot connect: an app speaking another protocol, or an expired or revoked credential.
 */
export class MobileAccessService extends Context.Service<
  MobileAccessService,
  {
    readonly status: Effect.Effect<MobileAccessStatus>;
    readonly recordRejection: (input: {
      readonly url: URL;
      readonly outcome: MobileConnectionAttempt["outcome"];
      readonly reason: string | null;
    }) => Effect.Effect<void>;
  }
>()("t3/mobileAccess/MobileAccessService") {}

/** Upstream T3 Code mobile releases this host was checked against; see the README test matrix. */
export const VERIFIED_MOBILE_CLIENTS = ["T3 Code Android 2.3.0 (Play beta 784, protocol 2)"];
const LIMIT = 20;

export function explainRejection(
  outcome: MobileConnectionAttempt["outcome"],
  clientProtocol: number | null,
  reason: string | null,
): string {
  if (outcome === "protocol-mismatch") {
    if (clientProtocol === null) return `The app did not say which protocol it speaks. Update the T3 Code app; this Continuum speaks protocol ${ORCHESTRATION_PROTOCOL_VERSION}.`;
    return clientProtocol > ORCHESTRATION_PROTOCOL_VERSION
      ? `The app speaks protocol ${clientProtocol}, newer than this Continuum (protocol ${ORCHESTRATION_PROTOCOL_VERSION}). Update Continuum to connect it.`
      : `The app speaks protocol ${clientProtocol}, older than this Continuum (protocol ${ORCHESTRATION_PROTOCOL_VERSION}). Update the app from the App Store or Google Play.`;
  }
  return reason === "expired"
    ? "The phone's pairing expired. Create a new pairing code here and scan it again."
    : reason === "revoked"
      ? "That phone's access was revoked. Pair it again if you want it back."
      : "The phone's credential was not accepted. Create a new pairing code here and scan it again.";
}

export const layer = Layer.effect(
  MobileAccessService,
  Effect.gen(function* () {
    const attempts = yield* Ref.make<ReadonlyArray<MobileConnectionAttempt>>([]);
    return MobileAccessService.of({
      status: Ref.get(attempts).pipe(
        Effect.map((list) => ({
          serverProtocol: ORCHESTRATION_PROTOCOL_VERSION,
          verifiedClients: VERIFIED_MOBILE_CLIENTS,
          attempts: list,
        })),
      ),
      recordRejection: ({ url, outcome, reason }) =>
        Effect.gen(function* () {
          const surface = url.searchParams.get("clientSurface") ?? "unknown";
          if (surface !== "mobile") return;
          const raw = url.searchParams.get("orchestrationProtocol");
          const clientProtocol = raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
          const attempt: MobileConnectionAttempt = {
            at: new Date().toISOString(),
            surface,
            appVersion: url.searchParams.get("clientAppVersion")?.slice(0, 64) ?? null,
            os: url.searchParams.get("clientOs")?.slice(0, 32) ?? null,
            clientProtocol,
            outcome,
            explanation: explainRejection(outcome, clientProtocol, reason),
          };
          yield* Ref.update(attempts, (list) => [attempt, ...list].slice(0, LIMIT));
        }),
    });
  }),
);
