import type { AgentctlSandboxesSnapshot, PeerLink } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as PeerLinks from "../peer/PeerLinks.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentctlSandboxes from "./AgentctlSandboxes.ts";
import type { SandboxLinkRecord } from "./sandboxModel.ts";

// Links each Sandbox this server reaches, supervised, while the beta is on, and moves the link to
// its new SSH forward on every reconnect. A Sandbox can claim any environment id, so this changes
// or forgets only links it made itself, recorded with when they were made: never a user's link.

const SANDBOX_LINK_ACCESS = "approval-required";
// Retries a link that failed and renews one before it lapses, while nothing else changes.
const CHECK_INTERVAL = Duration.minutes(10);
const RENEW_BEFORE = Duration.days(1);

const runningSandboxes = (snapshot: AgentctlSandboxesSnapshot) =>
  snapshot.sandboxes.flatMap((sandbox) =>
    sandbox.phase === "ready" && sandbox.action === null && sandbox.environmentId !== null
      ? [{ name: sandbox.name, environmentId: sandbox.environmentId }]
      : [],
  );

/** What a snapshot says that matters here, so provisioning progress does not check again. */
const linkState = (snapshot: AgentctlSandboxesSnapshot) =>
  [
    snapshot.status,
    ...snapshot.sandboxes.map(
      (sandbox) =>
        `${sandbox.name}:${sandbox.environmentId}:${sandbox.phase}:${sandbox.action}:${sandbox.settingsSeeded}`,
    ),
  ].join("\n");

const isOwn = (record: SandboxLinkRecord | undefined, link: PeerLink) =>
  record !== undefined &&
  record.environmentId === link.environmentId &&
  record.linkedAt === DateTime.formatIso(link.linkedAt);

const make = Effect.gen(function* () {
  const sandboxes = yield* AgentctlSandboxes.AgentctlSandboxes;
  const links = yield* PeerLinks.PeerLinks;
  const settings = yield* ServerSettings.ServerSettingsService;
  // Linking and forgetting each read and then change a link and its record.
  const lock = yield* Semaphore.make(1);

  const ensureLink = Effect.fn("AgentctlSandboxLinks.ensureLink")(
    function* ({ name, environmentId, httpBaseUrl }: AgentctlSandboxes.SandboxReached) {
      const record = (yield* sandboxes.sandboxLinks)[name];
      const existing = yield* links.get(environmentId);
      if (Option.isSome(existing)) {
        if (!isOwn(record, existing.value)) return;
        const renewAt = DateTime.subtractDuration(existing.value.expiresAt, RENEW_BEFORE);
        if (DateTime.isGreaterThan(renewAt, yield* DateTime.now)) {
          if (!existing.value.urls.includes(new URL(httpBaseUrl).origin)) {
            yield* links.relocate(environmentId, [httpBaseUrl], { ownForward: true });
          }
          return;
        }
      }
      const pairing = yield* sandboxes.pair(name);
      // Recreated since it was reached; reaching the new one links that.
      if (pairing.environmentId !== environmentId) return;
      const linked = yield* links.link(
        {
          url: httpBaseUrl,
          pairingCode: pairing.pairingToken,
          access: SANDBOX_LINK_ACCESS,
          expectedEnvironmentId: environmentId,
          expectedLabel: name,
        },
        { ownForward: true },
      );
      yield* sandboxes.recordSandboxLink(name, {
        environmentId,
        linkedAt: DateTime.formatIso(linked.linkedAt),
      });
      yield* Effect.logInfo("Linked an agentctl Sandbox.", { name, environmentId });
    },
    (effect, { name }) =>
      effect.pipe(
        lock.withPermits(1),
        // Refused while the Sandbox has the beta off; the next check tries again.
        Effect.catch((error) =>
          Effect.logInfo("Could not link an agentctl Sandbox.", { name, error: error.message }),
        ),
      ),
  );

  /** Forgets the links this made to Sandboxes a listing no longer has, or has under another id. */
  const forgetGone = Effect.fn("AgentctlSandboxLinks.forgetGone")(
    function* (snapshot: AgentctlSandboxesSnapshot) {
      const current = new Map(
        snapshot.sandboxes.map((sandbox) => [sandbox.name, sandbox.environmentId] as const),
      );
      for (const [name, record] of Object.entries(yield* sandboxes.sandboxLinks)) {
        if (current.get(name) === record.environmentId) continue;
        const existing = yield* links.get(record.environmentId);
        if (Option.isSome(existing) && isOwn(record, existing.value)) {
          yield* links.unlink(record.environmentId);
        }
        yield* sandboxes.recordSandboxLink(name, null);
      }
    },
    (effect) => effect.pipe(lock.withPermits(1), Effect.ignoreCause({ log: true })),
  );

  const check = Effect.fn("AgentctlSandboxLinks.check")(function* (
    snapshot: AgentctlSandboxesSnapshot,
  ) {
    // A listing that failed keeps its last Sandboxes, so only a fresh one can show one gone.
    if (snapshot.status === "available") yield* forgetGone(snapshot);
    yield* Effect.forEach(
      runningSandboxes(snapshot),
      ({ name, environmentId }) =>
        sandboxes.relayUpstream(name).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (httpBaseUrl) => ensureLink({ name, environmentId, httpBaseUrl }),
            }),
          ),
        ),
      { discard: true },
    );
  });

  const settingsChanges = yield* settings.subscribeChanges;
  const enabled = yield* links.enabled;
  yield* Stream.concat(
    Stream.make(enabled),
    settingsChanges.pipe(Stream.map((current) => current.linkedEnvironmentsEnabled)),
  ).pipe(
    Stream.changes,
    // Following the Sandboxes starts watching agentctl, so only while there is something to link.
    Stream.switchMap((on) =>
      on
        ? Stream.mergeAll(
            [
              sandboxes.changes.pipe(
                Stream.changesWith((left, right) => linkState(left) === linkState(right)),
                Stream.mapEffect(check),
              ),
              sandboxes.reached.pipe(Stream.mapEffect(ensureLink)),
              // The first tick comes at once, when the listing above already checks.
              Stream.tick(CHECK_INTERVAL).pipe(
                Stream.drop(1),
                Stream.mapEffect(() => Effect.flatMap(sandboxes.snapshot, check)),
              ),
            ],
            { concurrency: "unbounded" },
          )
        : Stream.empty,
    ),
    Stream.runDrain,
    Effect.forkScoped,
  );
});

export const layer = Layer.effectDiscard(make);
