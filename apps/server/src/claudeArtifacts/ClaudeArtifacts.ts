/**
 * The claude.ai Artifacts of every enabled Claude account, fetched on demand. The last result per
 * account stays in memory; nothing polls.
 */
import {
  type ClaudeArtifactAccount,
  ClaudeArtifactsError,
  type ClaudeArtifactsRefreshInput,
  type ClaudeArtifactsSnapshot,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import type {
  ProviderArtifactListResult,
  ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { mergeClaudeArtifactListPages, parseClaudeArtifactListPage } from "./ClaudeArtifactList.ts";

export class ClaudeArtifacts extends Context.Service<
  ClaudeArtifacts,
  {
    /** Each account's last result, without fetching. */
    readonly snapshot: Effect.Effect<ClaudeArtifactsSnapshot>;
    /** Fetches one account, or every account in parallel, then returns the snapshot. */
    readonly refresh: (
      input: ClaudeArtifactsRefreshInput,
    ) => Effect.Effect<ClaudeArtifactsSnapshot, ClaudeArtifactsError>;
  }
>()("t3/claudeArtifacts/ClaudeArtifacts") {}

type CachedAccount = Omit<ClaudeArtifactAccount, "instanceId" | "displayName">;

const IDLE: CachedAccount = { status: "idle", artifacts: [], skippedLines: 0 };

type ArtifactInstance = ProviderInstance & {
  readonly listArtifactPages: NonNullable<ProviderInstance["listArtifactPages"]>;
};

const listsArtifacts = (instance: ProviderInstance): instance is ArtifactInstance =>
  instance.enabled && instance.listArtifactPages !== undefined;

/** The new entry for an account; a failed fetch keeps the last good list. */
function nextCachedAccount(
  previous: CachedAccount,
  result: ProviderArtifactListResult,
  fetchedAt: string,
): CachedAccount {
  const kept = { artifacts: previous.artifacts, skippedLines: previous.skippedLines, fetchedAt };
  if (result._tag !== "pages") {
    return {
      ...kept,
      status: result._tag === "signedOut" ? "signedOut" : "error",
      message: result.message,
    };
  }
  const pages = result.pages.map(parseClaudeArtifactListPage);
  if (!pages.some((page) => page.hasList)) {
    const reply = result.pages.at(-1)?.trim().slice(0, 300);
    return {
      ...kept,
      status: "error",
      message: reply ? `Claude did not return a list: ${reply}` : "Claude did not return a list.",
    };
  }
  return {
    status: "ok",
    fetchedAt,
    ...mergeClaudeArtifactListPages(pages.filter((page) => page.hasList)),
  };
}

const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  // Fetches outlive the request that started them, so a closed client never strands a waiter.
  const scope = yield* Effect.scope;
  const cache = yield* Ref.make(new Map<ProviderInstanceId, CachedAccount>());
  const inFlight = new Map<ProviderInstanceId, Deferred.Deferred<void>>();

  const accounts = registry.listInstances.pipe(Effect.map((all) => all.filter(listsArtifacts)));

  const snapshot = Effect.gen(function* () {
    const entries = yield* Ref.get(cache);
    return {
      accounts: (yield* accounts).map((instance) => ({
        instanceId: instance.instanceId,
        displayName: instance.displayName ?? instance.instanceId,
        ...(entries.get(instance.instanceId) ?? IDLE),
      })),
    } satisfies ClaudeArtifactsSnapshot;
  });

  const fetchAccount = Effect.fn("ClaudeArtifacts.fetchAccount")(function* (
    instance: ArtifactInstance,
  ) {
    const result = yield* instance.listArtifactPages;
    const fetchedAt = DateTime.formatIso(yield* DateTime.now);
    yield* Ref.update(cache, (entries) => {
      const next = new Map(entries);
      next.set(
        instance.instanceId,
        nextCachedAccount(entries.get(instance.instanceId) ?? IDLE, result, fetchedAt),
      );
      return next;
    });
  });

  /** A second refresh of an account joins the one already running. */
  const refreshAccount = Effect.fn("ClaudeArtifacts.refreshAccount")(function* (
    instance: ArtifactInstance,
  ) {
    const running = inFlight.get(instance.instanceId);
    if (running !== undefined) return yield* Deferred.await(running);
    const done = yield* Deferred.make<void>();
    inFlight.set(instance.instanceId, done);
    yield* fetchAccount(instance).pipe(
      Effect.ensuring(
        Effect.sync(() => inFlight.delete(instance.instanceId)).pipe(
          Effect.andThen(Deferred.succeed(done, undefined)),
        ),
      ),
      Effect.forkIn(scope),
    );
    return yield* Deferred.await(done);
  });

  const refresh: ClaudeArtifacts["Service"]["refresh"] = Effect.fn("ClaudeArtifacts.refresh")(
    function* (input) {
      const all = yield* accounts;
      const targets =
        input.instanceId === undefined
          ? all
          : all.filter((instance) => instance.instanceId === input.instanceId);
      if (input.instanceId !== undefined && targets.length === 0) {
        return yield* new ClaudeArtifactsError({
          reason: "unknownInstance",
          message: `No enabled Claude account has the id "${input.instanceId}".`,
        });
      }
      yield* Effect.forEach(targets, refreshAccount, { concurrency: "unbounded", discard: true });
      return yield* snapshot;
    },
  );

  return ClaudeArtifacts.of({ snapshot, refresh });
});

export const layer = Layer.effect(ClaudeArtifacts, make);
