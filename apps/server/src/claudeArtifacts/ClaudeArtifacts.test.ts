import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import type {
  ProviderArtifactListResult,
  ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ClaudeArtifacts from "./ClaudeArtifacts.ts";

const PAGE = `2 artifacts, published by you or shared with you:
- (mine, web page, pinned) Board — https://claude.ai/artifact/AAA — updated 2026-11-18
- (shared) Shared Thing — https://claude.ai/artifact/BBB
- not a list item`;

/** An instance whose fetches return the queued results in order, counting calls. */
function fakeInstance(
  id: string,
  results: Array<Effect.Effect<ProviderArtifactListResult>>,
  options: { readonly enabled?: boolean; readonly lists?: boolean; readonly home?: string } = {},
) {
  const calls = { count: 0 };
  const instance = {
    instanceId: ProviderInstanceId.make(id),
    continuationIdentity: { continuationKey: `claude:home:${options.home ?? `/home/${id}`}` },
    displayName: `Claude ${id}`,
    enabled: options.enabled ?? true,
    ...(options.lists === false
      ? {}
      : {
          listArtifactPages: Effect.suspend(() => {
            calls.count += 1;
            return results.shift() ?? Effect.die("no result queued");
          }),
        }),
  } as unknown as ProviderInstance;
  return { instance, calls };
}

const layerWith = (instances: ReadonlyArray<ProviderInstance>) =>
  ClaudeArtifacts.layer.pipe(
    Layer.provide(
      Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        getInstance: (id) => Effect.succeed(instances.find((entry) => entry.instanceId === id)),
        listInstances: Effect.succeed(instances),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.die("unused"),
      }),
    ),
  );

const pages = (...texts: string[]): Effect.Effect<ProviderArtifactListResult> =>
  Effect.succeed({ _tag: "pages", pages: texts });

describe("ClaudeArtifacts", () => {
  it.effect("lists only enabled accounts that can list, idle until refreshed", () => {
    const uplifted = fakeInstance("claudeAgent", []);
    const disabled = fakeInstance("claudeAgent_off", [], { enabled: false });
    const codex = fakeInstance("codex", [], { lists: false });
    return Effect.gen(function* () {
      const service = yield* ClaudeArtifacts.ClaudeArtifacts;
      expect(yield* service.snapshot).toEqual({
        accounts: [
          {
            instanceId: "claudeAgent",
            displayName: "Claude claudeAgent",
            status: "idle",
            artifacts: [],
            skippedLines: 0,
            partial: false,
          },
        ],
      });
    }).pipe(Effect.provide(layerWith([uplifted.instance, disabled.instance, codex.instance])));
  });

  it.effect("parses each account's pages and keeps the last good list when a fetch fails", () => {
    const uplifted = fakeInstance("claudeAgent", [
      pages(PAGE),
      Effect.succeed({ _tag: "failed", message: "Listing artifacts timed out." }),
    ]);
    const bark = fakeInstance("claudeAgent_bark", [
      Effect.succeed({ _tag: "signedOut", message: "Sign in." }),
    ]);
    return Effect.gen(function* () {
      const service = yield* ClaudeArtifacts.ClaudeArtifacts;
      const first = yield* service.refresh({});
      expect(first.accounts.map((account) => [account.instanceId, account.status])).toEqual([
        ["claudeAgent", "ok"],
        ["claudeAgent_bark", "signedOut"],
      ]);
      expect(first.accounts[0]).toMatchObject({ skippedLines: 1 });
      expect(first.accounts[0]?.artifacts.map((artifact) => artifact.title)).toEqual([
        "Board",
        "Shared Thing",
      ]);
      expect(first.accounts[0]?.fetchedAt).toBeDefined();

      const second = yield* service.refresh({ instanceId: ProviderInstanceId.make("claudeAgent") });
      expect(second.accounts[0]).toMatchObject({
        status: "error",
        message: "Listing artifacts timed out.",
      });
      expect(second.accounts[0]?.artifacts).toHaveLength(2);
      expect(uplifted.calls.count).toBe(2);
      expect(bark.calls.count).toBe(1);
    }).pipe(Effect.provide(layerWith([uplifted.instance, bark.instance])));
  });

  it.effect("drops an account's list when its instance is pointed at another Claude home", () => {
    const before = fakeInstance("claudeAgent", [pages(PAGE)], { home: "/a" });
    const after = fakeInstance("claudeAgent", [], { home: "/b" });
    const instances = [before.instance];
    return Effect.gen(function* () {
      const service = yield* ClaudeArtifacts.ClaudeArtifacts;
      yield* service.refresh({});
      instances[0] = after.instance;
      expect((yield* service.snapshot).accounts[0]).toMatchObject({
        status: "idle",
        artifacts: [],
      });
    }).pipe(Effect.provide(layerWith(instances)));
  });

  it.effect("reports an error, not an empty list, when the tool returned no list", () => {
    const uplifted = fakeInstance("claudeAgent", [pages("Error: claude.ai is unavailable.")]);
    return Effect.gen(function* () {
      const service = yield* ClaudeArtifacts.ClaudeArtifacts;
      const snapshot = yield* service.refresh({});
      expect(snapshot.accounts[0]).toMatchObject({
        status: "error",
        message: "Claude did not return a list: Error: claude.ai is unavailable.",
        artifacts: [],
      });
    }).pipe(Effect.provide(layerWith([uplifted.instance])));
  });

  it.effect("joins a refresh already running for the same account", () => {
    return Effect.gen(function* () {
      const uplifted = fakeInstance("claudeAgent", [
        Effect.sleep("1 second").pipe(Effect.andThen(pages(PAGE))),
      ]);
      yield* Effect.gen(function* () {
        const service = yield* ClaudeArtifacts.ClaudeArtifacts;
        const first = yield* service.refresh({}).pipe(Effect.forkChild);
        const second = yield* service.refresh({}).pipe(Effect.forkChild);
        yield* TestClock.adjust("1 second");
        const [a, b] = yield* Fiber.joinAll([first, second]);
        expect(a?.accounts[0]?.status).toBe("ok");
        expect(b?.accounts[0]?.status).toBe("ok");
        expect(uplifted.calls.count).toBe(1);
      }).pipe(Effect.provide(layerWith([uplifted.instance])));
    });
  });

  it.effect("rejects an account id that cannot list", () => {
    const codex = fakeInstance("codex", [], { lists: false });
    return Effect.gen(function* () {
      const service = yield* ClaudeArtifacts.ClaudeArtifacts;
      const error = yield* service
        .refresh({ instanceId: ProviderInstanceId.make("codex") })
        .pipe(Effect.flip);
      expect(error.reason).toBe("unknownInstance");
    }).pipe(Effect.provide(layerWith([codex.instance])));
  });
});
