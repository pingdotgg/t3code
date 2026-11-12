import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderAuth,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as CodexAccountSwitch from "./CodexAccountSwitch.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

const codex = ProviderInstanceId.make("codex");
const codexWork = ProviderInstanceId.make("codex-work");
const claude = ProviderInstanceId.make("claude");

const provider = (
  instanceId: ProviderInstanceId,
  auth: ServerProviderAuth,
  driver = ProviderDriverKind.make("codex"),
): ServerProvider => ({
  instanceId,
  driver,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth,
  checkedAt: "2026-11-12T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
});

const signedIn = (email: string, workspaceId?: string): ServerProviderAuth => ({
  status: "authenticated",
  email,
  ...(workspaceId === undefined ? {} : { workspaceId }),
});

it.effect("closes a Codex instance's sessions only when its signed-in account changes", () =>
  Effect.gen(function* () {
    const changes = yield* Queue.unbounded<ReadonlyArray<ServerProvider>>();
    const closed = yield* Queue.unbounded<ProviderInstanceId>();
    const claudeDriver = ProviderDriverKind.make("claude");
    yield* Layer.build(
      CodexAccountSwitch.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProviderRegistry.ProviderRegistry)({
              getProviders: Effect.succeed([
                provider(codex, signedIn("alice@example.com", "ws-alice")),
                provider(codexWork, signedIn("team@example.com", "ws-personal")),
              ]),
              streamChanges: Stream.fromQueue(changes),
            }),
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
              closeInstance: (instanceId) => Queue.offer(closed, instanceId).pipe(Effect.asVoid),
            }),
          ),
        ),
      ),
    );

    yield* Queue.offerAll(changes, [
      // A token refresh rewrites auth.json without changing the account.
      [provider(codex, signedIn("alice@example.com", "ws-alice"))],
      [provider(codex, signedIn("alice@example.com"))],
      [provider(codex, { status: "unknown" })],
      [provider(claude, signedIn("one@example.com"), claudeDriver)],
      [provider(claude, signedIn("two@example.com"), claudeDriver)],
      [
        provider(codex, signedIn("bob@example.com")),
        provider(codexWork, signedIn("team@example.com", "ws-team")),
      ],
    ]);

    assert.deepStrictEqual(
      [yield* Queue.take(closed), yield* Queue.take(closed)],
      [codex, codexWork],
    );
    assert.strictEqual(yield* Queue.size(closed), 0);
  }).pipe(Effect.scoped),
);
