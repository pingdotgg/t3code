import { ModelSelection, type ServerProvider } from "@t3tools/contracts";
import {
  buildExplicitProviderOptionSelectionsFromDescriptors,
  buildProviderOptionSelectionsFromDescriptors,
  createModelSelection,
  draftModelPickMatchesThread,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";

/**
 * Nadir routing: before a user's turn starts, ask Nadir (getnadir.com) which model from the
 * selected provider instance's menu should run it, and run that one. The model the user picked
 * stays the ceiling: Nadir never routes above it. Any failure keeps the user's pick.
 */

const NADIR_BUCKET_URL = "https://api.getnadir.com/v1/bucket";
const MAX_PROMPT_CHARS = 40_000;
// A short follow-up ("yes", "do it") depends on context Nadir does not see.
const MIN_PROMPT_WORDS = 4;

const Ceiling = Schema.Struct({ baseline: ModelSelection, chosen: ModelSelection });
type Ceiling = typeof Ceiling.Type;

/**
 * A thread's routed turn: the user's pick (the ceiling) and the model Nadir ran instead. It
 * lives on disk so a restart cannot turn a routed-down model into the thread's ceiling.
 */
export class NadirCeilings extends Context.Service<
  NadirCeilings,
  {
    readonly get: (threadId: string) => Effect.Effect<Option.Option<Ceiling>>;
    /** Undefined clears the thread's record. */
    readonly save: (threadId: string, ceiling: Ceiling | undefined) => Effect.Effect<void>;
    /** Holds one turn's read, Nadir call and write at a time for each thread. */
    readonly lock: (threadId: string) => Semaphore.Semaphore;
  }
>()("t3/orchestration-v2/NadirRouting/NadirCeilings") {}

// ponytail: the memory copy and the locks hold one small entry per routed thread for the life of
// the process. The memory copy keeps a ceiling the disk failed to save.
const layerFromStore = Layer.effect(
  NadirCeilings,
  Effect.gen(function* () {
    const store = KeyValueStore.toSchemaStore(yield* KeyValueStore.KeyValueStore, Ceiling);
    const memory = new Map<string, Ceiling | undefined>();
    const locks = new Map<string, Semaphore.Semaphore>();
    return {
      get: Effect.fn("NadirCeilings.get")(function* (threadId: string) {
        if (memory.has(threadId)) return Option.fromUndefinedOr(memory.get(threadId));
        return yield* store.get(threadId).pipe(
          Effect.tap((found) =>
            Effect.sync(() => memory.set(threadId, Option.getOrUndefined(found))),
          ),
          Effect.orElseSucceed(() => Option.none<Ceiling>()),
        );
      }),
      save: Effect.fn("NadirCeilings.save")(function* (
        threadId: string,
        ceiling: Ceiling | undefined,
      ) {
        memory.set(threadId, ceiling);
        yield* (ceiling === undefined ? store.remove(threadId) : store.set(threadId, ceiling)).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Nadir ceiling kept in memory only", { cause }),
          ),
        );
      }),
      lock: (threadId) => {
        let lock = locks.get(threadId);
        if (lock === undefined) {
          lock = Semaphore.makeUnsafe(1);
          locks.set(threadId, lock);
        }
        return lock;
      },
    };
  }),
);

export const layerCeilingsMemory = layerFromStore.pipe(Layer.provide(KeyValueStore.layerMemory));

export const layerCeilingsAt = (directory: string) =>
  layerFromStore.pipe(Layer.provide(KeyValueStore.layerFileSystem(directory)));

// ponytail: one small file per thread while it runs below its ceiling; a thread deleted in that
// state leaves its file. Prune with thread deletion if the directory ever grows.
export const layerCeilings = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return layerCeilingsAt(path.join(config.stateDir, "nadir-ceilings")).pipe(
      Layer.catch(() =>
        Layer.effectDiscard(
          Effect.logWarning("Nadir ceiling directory unavailable; ceilings reset on restart"),
        ).pipe(Layer.provideMerge(layerCeilingsMemory)),
      ),
    );
  }),
);

/** The user's pick: the incoming selection, unless it is what Nadir chose last turn. */
export const baselineFor = (
  ceilings: NadirCeilings["Service"],
  threadId: string,
  incoming: ModelSelection,
) =>
  ceilings
    .get(threadId)
    .pipe(
      Effect.map((prior) =>
        Option.isSome(prior) && draftModelPickMatchesThread(incoming, prior.value.chosen)
          ? prior.value.baseline
          : incoming,
      ),
    );

/** Keeps the ceiling only while the thread runs below it. */
export const rememberChoice = (
  ceilings: NadirCeilings["Service"],
  threadId: string,
  baseline: ModelSelection,
  chosen: ModelSelection,
) => ceilings.save(threadId, baseline === chosen ? undefined : { baseline, chosen });

/** Models the user can pick for this instance, the menu Nadir chooses from. */
function modelMenu(provider: ServerProvider | undefined): ReadonlyArray<string> {
  return (
    provider?.models.filter((model) => model.isLegacy !== true).map((model) => model.slug) ?? []
  );
}

/**
 * The routed model keeps the options the user's pick ran with, defaults included, so the effort
 * the picker showed still applies. An option the routed model lacks takes its own default.
 */
export function routedSelection(
  baseline: ModelSelection,
  model: string,
  provider: ServerProvider | undefined,
): ModelSelection {
  const capabilitiesOf = (slug: string) =>
    provider?.models.find((candidate) => candidate.slug === slug)?.capabilities ?? undefined;
  const from = capabilitiesOf(baseline.model);
  const to = capabilitiesOf(model);
  if (to === undefined) return createModelSelection(baseline.instanceId, model);
  const picked =
    from === undefined
      ? baseline.options
      : buildProviderOptionSelectionsFromDescriptors(
          getProviderOptionDescriptors({ caps: from, selections: baseline.options }),
        );
  const options = buildExplicitProviderOptionSelectionsFromDescriptors(
    getProviderOptionDescriptors({ caps: to, selections: picked }),
    picked,
  );
  return createModelSelection(baseline.instanceId, model, options);
}

export interface NadirCacheState {
  /** The model holding the thread's warm prompt cache. */
  readonly model: string;
  /** Tokens in the thread's current context window. */
  readonly contextTokens?: number | undefined;
}

export function nadirRequestBody(input: {
  readonly text: string;
  readonly baseline: string;
  readonly menu: ReadonlyArray<string>;
  readonly driver: string | undefined;
  readonly threadId: string;
  readonly cache?: NadirCacheState | undefined;
}) {
  const client =
    input.driver === "codex" ? "codex" : input.driver === "claudeAgent" ? "claude-code" : null;
  return {
    prompt: input.text,
    source: "t3code",
    role: "main",
    requested_model: input.baseline,
    menu: input.menu,
    axes: ["coding", "agentic"],
    agent_policy: { main: "auto" },
    policy: { allow_route_up: false, min_savings_pct: 0.05 },
    ...(client === null ? {} : { agent_session: { client, session_id: input.threadId } }),
    // Omitting cached_tokens makes Nadir assume the whole context is cached: the costly reading.
    ...(input.cache === undefined
      ? {}
      : {
          cache: {
            model: input.cache.model,
            expected_remaining_turns: 1,
            ...(input.cache.contextTokens === undefined
              ? {}
              : { current_input_tokens: input.cache.contextTokens }),
          },
        }),
  };
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

/** The model to run, from Nadir's answer. Anything incomplete or unqualified keeps the baseline. */
export function pickModel(
  response: unknown,
  context: {
    readonly baseline: string;
    readonly current: string;
    readonly menu: ReadonlyArray<string>;
  },
): string {
  const answer = record(response);
  if (answer === undefined) return context.baseline;
  // An organization policy on the account names the model to use.
  // An organization's pinned model outranks the user's pick; the settings text says so.
  const governed = answer.governance_model;
  if (typeof governed === "string") {
    return context.menu.includes(governed) ? governed : context.baseline;
  }
  const selected = answer.selected_model;
  const policy = record(answer.policy);
  if (
    typeof selected !== "string" ||
    !context.menu.includes(selected) ||
    answer.coverage_held === true ||
    answer.input_truncated === true ||
    policy?.advised_model !== selected
  ) {
    return context.baseline;
  }
  if (selected === context.baseline || selected === context.current) return selected;
  if (policy.suppressed !== false) return context.baseline;
  // A warm cache can make the cheaper model the costlier turn; never stay on a cheaper last-turn
  // model for a task Nadir rates harder, so fall back to the user's pick.
  if (record(answer.cache_advice)?.decision === "stay_warm") return context.baseline;
  return selected;
}

/** True when Nadir routing is on in Settings. */
export const isEnabled = ServerSettings.ServerSettingsService.pipe(
  Effect.flatMap((service) => service.getSettings),
  Effect.map((settings) => settings.nadirRouting),
  Effect.orElseSucceed(() => false),
);

const askNadir = Effect.fn("NadirRouting.askNadir")(function* (
  client: HttpClient.HttpClient,
  body: unknown,
) {
  // Optional: without a key Nadir answers on its free anonymous tier.
  const apiKey = (yield* Config.String("NADIR_API_KEY").pipe(Config.withDefault(""))).trim();
  const request = HttpClientRequest.post(NADIR_BUCKET_URL).pipe(
    apiKey ? HttpClientRequest.setHeader("X-API-Key", apiKey) : (request) => request,
    HttpClientRequest.bodyJsonUnsafe(body),
  );
  return yield* client.execute(request).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.json),
    Effect.timeout("2500 millis"),
  );
});

/**
 * The selection a user's turn should run on. Returns `selection` unchanged when routing is off or
 * the prompt is too short or long to judge. When Nadir is slow, down or unsure, the turn runs on
 * the user's pick.
 */
export const chooseModelSelection = Effect.fn("NadirRouting.chooseModelSelection")(
  function* (input: {
    readonly threadId: string;
    readonly text: string;
    readonly selection: ModelSelection;
    readonly cache?: NadirCacheState | undefined;
  }) {
    // Optional so callers outside the client intake (MCP tools, tests) need not provide them.
    const client = yield* Effect.serviceOption(HttpClient.HttpClient);
    const registry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
    const ceilings = yield* Effect.serviceOption(NadirCeilings);
    if (
      Option.isNone(client) ||
      Option.isNone(registry) ||
      Option.isNone(ceilings) ||
      !(yield* isEnabled)
    ) {
      return input.selection;
    }
    const store = ceilings.value;
    return yield* store.lock(input.threadId).withPermits(1)(
      Effect.gen(function* () {
        const baseline = yield* baselineFor(store, input.threadId, input.selection);
        const text = input.text.trim();
        const judgeable =
          text.length <= MAX_PROMPT_CHARS &&
          !text.startsWith("/") &&
          text.split(/\s+/).length >= MIN_PROMPT_WORDS;
        const providers = yield* registry.value.getProviders;
        const provider = providers.find(
          (candidate) => candidate.instanceId === baseline.instanceId,
        );
        const menu = modelMenu(provider);
        // A short follow-up or a slash command continues on the thread's model; the ceiling stays.
        if (!judgeable || !menu.includes(baseline.model)) return input.selection;
        const current = input.cache?.model ?? input.selection.model;
        const answer = yield* askNadir(
          client.value,
          nadirRequestBody({
            text,
            baseline: baseline.model,
            menu,
            driver: provider?.driver,
            threadId: input.threadId,
            cache: input.cache,
          }),
        ).pipe(
          Effect.tapError((cause) => Effect.logDebug("Nadir routing skipped", { cause })),
          Effect.orElseSucceed(() => null),
        );
        const model = pickModel(answer, { baseline: baseline.model, current, menu });
        const chosen =
          model === baseline.model ? baseline : routedSelection(baseline, model, provider);
        yield* rememberChoice(store, input.threadId, baseline, chosen);
        if (model !== baseline.model) {
          yield* Effect.logInfo("Nadir routed turn", { from: baseline.model, to: model });
        }
        return chosen;
      }),
    );
  },
);
