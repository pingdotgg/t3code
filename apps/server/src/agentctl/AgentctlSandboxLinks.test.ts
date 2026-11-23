import { expect, it } from "@effect/vitest";
import {
  type AgentctlSandbox,
  type AgentctlSandboxesSnapshot,
  EnvironmentId,
  PeerLinkError,
  type PeerLink,
  type PeerLinkCreateInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as PeerLinks from "../peer/PeerLinks.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentctlSandboxLinks from "./AgentctlSandboxLinks.ts";
import * as AgentctlSandboxes from "./AgentctlSandboxes.ts";
import type { SandboxLinkRecord } from "./sandboxModel.ts";

const first = EnvironmentId.make("environment-first");
const second = EnvironmentId.make("environment-second");
const other = EnvironmentId.make("environment-other");

const sandbox = (overrides: Partial<AgentctlSandbox>): AgentctlSandbox => ({
  name: "worker",
  phase: "ready",
  detail: null,
  since: null,
  cpu: null,
  memory: null,
  disk: null,
  network: null,
  sshAccess: true,
  environmentId: first,
  settingsSeeded: true,
  harnesses: [],
  workingDirectory: null,
  connectError: null,
  action: null,
  actionError: null,
  manifestPath: null,
  variant: null,
  ...overrides,
});

const snapshot = (sandboxes: ReadonlyArray<AgentctlSandbox>): AgentctlSandboxesSnapshot => ({
  status: "available",
  error: null,
  sandboxes,
  homeDirectory: "/home/user",
});

const peerLink = (environmentId: EnvironmentId, linkedAt: DateTime.Utc): PeerLink => ({
  environmentId,
  label: "machine",
  urls: ["http://127.0.0.1:41001"],
  access: "full-access",
  linkedAt,
  expiresAt: DateTime.add(linkedAt, { days: 30 }),
  lastReachedAt: null,
  lastError: null,
});

type Call =
  | { readonly _tag: "link"; readonly input: PeerLinkCreateInput; readonly options: unknown }
  | {
      readonly _tag: "relocate";
      readonly environmentId: EnvironmentId;
      readonly urls: unknown;
      readonly options: unknown;
    }
  | { readonly _tag: "unlink"; readonly environmentId: EnvironmentId };

/**
 * Runs the links layer against queues standing in for agentctl, with links and their records held
 * here, and records what it asks of PeerLinks.
 */
const harness = (
  options: {
    readonly stored?: ReadonlyArray<PeerLink>;
    readonly records?: Record<string, SandboxLinkRecord>;
    readonly pairing?: Effect.Effect<void>;
    readonly failLinks?: number;
  } = {},
) =>
  Effect.gen(function* () {
    const changes = yield* Queue.unbounded<AgentctlSandboxesSnapshot>();
    const reached = yield* Queue.unbounded<AgentctlSandboxes.SandboxReached>();
    const calls = yield* Queue.unbounded<Call>();
    const stored = new Map((options.stored ?? []).map((link) => [link.environmentId, link]));
    const records: Record<string, SandboxLinkRecord> = { ...options.records };
    let latest = snapshot([]);
    let failLinks = options.failLinks ?? 0;
    const upstream = { url: "http://127.0.0.1:41001/" };
    const record = (call: Call) => Queue.offer(calls, call).pipe(Effect.asVoid);

    yield* Layer.build(
      AgentctlSandboxLinks.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(AgentctlSandboxes.AgentctlSandboxes)({
              changes: Stream.fromQueue(changes).pipe(
                Stream.tap((next) => Effect.sync(() => void (latest = next))),
              ),
              snapshot: Effect.sync(() => latest),
              reached: Stream.fromQueue(reached),
              relayUpstream: () => Effect.succeedSome(upstream.url),
              pair: (name) =>
                (options.pairing ?? Effect.void).pipe(
                  Effect.as({
                    environmentId:
                      latest.sandboxes.find((s) => s.name === name)?.environmentId ?? first,
                    pairingToken: "PAIRCODE",
                  }),
                ),
              sandboxLinks: Effect.sync(() => ({ ...records })),
              recordSandboxLink: (name, link) =>
                Effect.sync(() => {
                  if (link === null) delete records[name];
                  else records[name] = link;
                }),
            }),
            Layer.mock(PeerLinks.PeerLinks)({
              enabled: Effect.succeed(true),
              get: (environmentId) =>
                Effect.succeed(Option.fromNullishOr(stored.get(environmentId))),
              link: (input, options) =>
                Effect.gen(function* () {
                  if (failLinks > 0) {
                    failLinks -= 1;
                    yield* record({ _tag: "link", input, options });
                    return yield* new PeerLinkError({ reason: "disabled", message: "Off there." });
                  }
                  const linked = {
                    ...peerLink(input.expectedEnvironmentId!, yield* DateTime.now),
                    urls: [new URL(input.url).origin],
                    access: input.access,
                  };
                  stored.set(linked.environmentId, linked);
                  yield* record({ _tag: "link", input, options });
                  return linked;
                }),
              relocate: (environmentId, urls, options) =>
                record({ _tag: "relocate", environmentId, urls, options }).pipe(Effect.as(true)),
              unlink: (environmentId) =>
                Effect.sync(() => stored.delete(environmentId)).pipe(
                  Effect.tap(() => record({ _tag: "unlink", environmentId })),
                ),
            }),
            Layer.mock(ServerSettings.ServerSettingsService)({
              subscribeChanges: Effect.succeed(Stream.never),
            }),
          ),
        ),
      ),
    );
    return { changes, reached, calls, upstream, records, stored };
  });

const linkOf = (environmentId: EnvironmentId, name = "worker") => ({
  _tag: "link",
  input: {
    url: "http://127.0.0.1:41001/",
    pairingCode: "PAIRCODE",
    access: "approval-required",
    expectedEnvironmentId: environmentId,
    expectedLabel: name,
  },
  // The forward is loopback, which PeerLinks otherwise takes for this machine.
  options: { ownForward: true },
});

it.effect(
  "links a running Sandbox once, supervised, and moves the link when its forward moves",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { changes, reached, calls, upstream } = yield* harness();

        yield* Queue.offer(changes, snapshot([sandbox({})]));
        expect(yield* Queue.take(calls)).toEqual(linkOf(first));

        // A reconnect at the same forward changes nothing; at a new one, the link follows it.
        yield* Queue.offer(reached, {
          name: "worker",
          environmentId: first,
          httpBaseUrl: upstream.url,
        });
        upstream.url = "http://127.0.0.1:41002/";
        yield* Queue.offer(reached, {
          name: "worker",
          environmentId: first,
          httpBaseUrl: upstream.url,
        });
        expect(yield* Queue.take(calls)).toEqual({
          _tag: "relocate",
          environmentId: first,
          urls: ["http://127.0.0.1:41002/"],
          options: { ownForward: true },
        });
        expect(yield* Queue.size(calls)).toBe(0);
      }),
    ),
);

it.effect(
  "never moves, renews or forgets a link it did not make, whatever id a Sandbox claims",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const epoch = yield* DateTime.now;
        // The user's own full-access links: one live, one lapsed.
        const yours = peerLink(other, epoch);
        const lapsed = { ...peerLink(second, epoch), expiresAt: epoch };
        const { changes, reached, calls, stored } = yield* harness({ stored: [yours, lapsed] });

        yield* Queue.offer(reached, {
          name: "impostor",
          environmentId: other,
          httpBaseUrl: "http://127.0.0.1:41009/",
        });
        yield* Queue.offer(
          changes,
          snapshot([
            sandbox({ name: "impostor", environmentId: other }),
            sandbox({ name: "lapsed", environmentId: second }),
            sandbox({ name: "worker" }),
          ]),
        );
        // Only the Sandbox with no link of its id is linked.
        expect(yield* Queue.take(calls)).toEqual(linkOf(first));
        yield* Queue.offer(changes, snapshot([]));
        expect(yield* Queue.take(calls)).toEqual({ _tag: "unlink", environmentId: first });
        expect(yield* Queue.size(calls)).toBe(0);
        expect(stored.get(other)).toEqual(yours);
        expect(stored.get(second)).toEqual(lapsed);
      }),
    ),
);

it.effect(
  "forgets the links it made to Sandboxes deleted or recreated, even while it was down",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const epoch = yield* DateTime.now;
        const linkedAt = DateTime.formatIso(epoch);
        const { changes, calls, records } = yield* harness({
          stored: [peerLink(first, epoch), peerLink(second, epoch)],
          records: {
            worker: { environmentId: first, linkedAt },
            // Deleted while this server was stopped.
            gone: { environmentId: second, linkedAt },
            // Its link was since made again by the user, so it is theirs now.
            relinked: { environmentId: other, linkedAt: "2020-01-01T00:00:00.000Z" },
          },
        });

        yield* Queue.offer(changes, snapshot([sandbox({ phase: "stopped", environmentId: null })]));
        expect(yield* Queue.take(calls)).toEqual({ _tag: "unlink", environmentId: first });
        expect(yield* Queue.take(calls)).toEqual({ _tag: "unlink", environmentId: second });
        expect(yield* Queue.size(calls)).toBe(0);
        expect(records).toEqual({});
      }),
    ),
);

it.effect("forgets a link made while its Sandbox was being deleted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const pairing = yield* Deferred.make<void>();
      const pairingStarted = yield* Deferred.make<void>();
      const { changes, reached, calls } = yield* harness({
        pairing: Deferred.succeed(pairingStarted, undefined).pipe(
          Effect.andThen(Deferred.await(pairing)),
        ),
      });

      yield* Queue.offer(reached, {
        name: "worker",
        environmentId: first,
        httpBaseUrl: "http://127.0.0.1:41001/",
      });
      yield* Deferred.await(pairingStarted);
      yield* Queue.offer(changes, snapshot([]));
      yield* Deferred.succeed(pairing, undefined);
      expect(yield* Queue.take(calls)).toEqual(linkOf(first));
      expect(yield* Queue.take(calls)).toEqual({ _tag: "unlink", environmentId: first });
    }),
  ),
);

it.effect("tries a refused link again, and renews a link before it lapses", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { changes, calls, stored } = yield* harness({ failLinks: 1 });

      yield* Queue.offer(changes, snapshot([sandbox({})]));
      expect(yield* Queue.take(calls)).toEqual(linkOf(first));
      expect(stored.has(first)).toBe(false);
      yield* TestClock.adjust("10 minutes");
      expect(yield* Queue.take(calls)).toEqual(linkOf(first));
      expect(stored.has(first)).toBe(true);

      yield* TestClock.adjust("29 days");
      expect(yield* Queue.take(calls)).toEqual(linkOf(first));
    }),
  ),
);
