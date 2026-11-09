import { useAtomValue } from "@effect/atom-react";
import { providerClients } from "@t3tools/client-runtime/provider-clients";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
  type ServerSettings,
  type TextGeneratorConfig,
  type TextGeneratorKind,
  type TextGeneratorModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import {
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
  providerInstanceEntriesFor,
} from "./providerInstances";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { formatEnvironmentQueryError } from "./state/query";
import { serverEnvironment } from "./state/server";

export interface TextGeneratorPreset {
  readonly id: "openai" | "openrouter" | "anthropic" | "custom";
  readonly label: string;
  readonly kind: TextGeneratorKind;
  /** Empty for a custom server, whose URL the user enters. */
  readonly baseUrl: string;
}

export const TEXT_GENERATOR_PRESETS: ReadonlyArray<TextGeneratorPreset> = [
  { id: "openai", label: "OpenAI", kind: "openaiCompatible", baseUrl: "https://api.openai.com/v1" },
  {
    id: "openrouter",
    label: "OpenRouter",
    kind: "openaiCompatible",
    baseUrl: "https://openrouter.ai/api/v1",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
  },
  { id: "custom", label: "Custom (OpenAI-compatible)", kind: "openaiCompatible", baseUrl: "" },
];

export function textGeneratorDisplayName(config: TextGeneratorConfig): string {
  if (config.label) return config.label;
  const preset = TEXT_GENERATOR_PRESETS.find(
    (candidate) => candidate.baseUrl === config.baseUrl && candidate.kind === config.kind,
  );
  if (preset) return preset.label;
  try {
    return new URL(config.baseUrl).host;
  } catch {
    return config.baseUrl;
  }
}

/**
 * The service a text generator reaches, which picks its picker icon. It stands in for the driver
 * kind in picker entries only, so generators of one service share an icon and get instance badges.
 */
export function textGeneratorBrand(config: Pick<TextGeneratorConfig, "kind" | "baseUrl">) {
  if (config.kind === "anthropic") return ProviderDriverKind.make("anthropic");
  let url: URL | null = null;
  try {
    url = new URL(config.baseUrl);
  } catch {}
  const host = url?.hostname ?? "";
  if (host === "openrouter.ai" || host.endsWith(".openrouter.ai")) {
    return ProviderDriverKind.make("openrouter");
  }
  if (host === "api.openai.com") return ProviderDriverKind.make("openai");
  if (url?.port === "11434" || host.includes("ollama")) return ProviderDriverKind.make("ollama");
  return ProviderDriverKind.make("openaiCompatible");
}

/**
 * A new text generator id. Selections name a text generator by the same id as a provider
 * instance, so it must not match a configured instance, a driver's default instance, or
 * another text generator.
 */
export function nextTextGeneratorId(
  base: string,
  settings: Pick<ServerSettings, "providerInstances" | "textGenerators">,
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId">>,
): ProviderInstanceId {
  const taken = new Set<string>([
    ...Object.keys(settings.providerInstances),
    ...Object.keys(settings.textGenerators),
    ...providers.map((provider) => provider.instanceId),
    ...providerClients.definitions.map((definition) => definition.driverKind),
  ]);
  let id = base;
  for (let suffix = 2; taken.has(id); suffix += 1) {
    id = `${base}-${suffix}`;
  }
  return ProviderInstanceId.make(id);
}

type ModelsKey = readonly [
  environmentId: EnvironmentId,
  id: ProviderInstanceId,
  // The connection settings, so editing them asks again instead of reusing a stale list.
  kind: TextGeneratorKind,
  baseUrl: string,
  apiKey: TextGeneratorConfig["apiKey"],
];

const refreshCountAtom = Atom.family((key: string) =>
  Atom.make(0).pipe(Atom.keepAlive, Atom.withLabel(`text-generator-refresh:${key}`)),
);

const textGeneratorModelsAtom = Atom.family((key: string) => {
  const [environmentId, id] = JSON.parse(key) as ModelsKey;
  return Atom.make((get) => {
    // Read again after a refresh; the server's cache already holds the new list by then.
    get(refreshCountAtom(`${environmentId}:${id}`));
    return Effect.promise(() =>
      runAtomCommand(
        get.registry,
        serverEnvironment.listTextGeneratorModels,
        { environmentId, input: { id } },
        { reportFailure: false },
      ),
    ).pipe(
      Effect.flatMap((result) =>
        result._tag === "Success"
          ? Effect.succeed(result.value.models)
          : Effect.fail(formatEnvironmentQueryError(result.cause)),
      ),
    );
  }).pipe(Atom.setIdleTTL(5 * 60_000), Atom.withLabel(`text-generator-models:${key}`));
});

const textGeneratorCatalogAtom = Atom.family((keys: string) =>
  Atom.make((get) =>
    (JSON.parse(keys) as ReadonlyArray<string>).map((key) => get(textGeneratorModelsAtom(key))),
  ).pipe(Atom.withLabel(`text-generator-catalog:${keys}`)),
);

/**
 * Asks the API for its model list again, skipping the server's cache, then has open pickers
 * read it. Resolves to the model count, or the error to show.
 */
export async function refreshTextGeneratorModels(
  environmentId: EnvironmentId,
  id: ProviderInstanceId,
): Promise<{ readonly count: number } | { readonly error: string }> {
  const result = await runAtomCommand(
    appAtomRegistry,
    serverEnvironment.listTextGeneratorModels,
    { environmentId, input: { id, refresh: true } },
    { reportFailure: false },
  );
  const atom = refreshCountAtom(`${environmentId}:${id}`);
  appAtomRegistry.set(atom, appAtomRegistry.get(atom) + 1);
  return result._tag === "Success"
    ? { count: result.value.models.length }
    : { error: formatEnvironmentQueryError(result.cause) };
}

function toProviderModel(model: TextGeneratorModel): ServerProviderModel {
  return { slug: model.id, name: model.name, isCustom: false, capabilities: null };
}

/** Picker stand-in for a text generator. It never leaves the settings pickers. */
function textGeneratorSnapshot(
  id: ProviderInstanceId,
  config: TextGeneratorConfig,
  result: AsyncResult.AsyncResult<ReadonlyArray<TextGeneratorModel>, string>,
  selectedModels: ReadonlyArray<string>,
): ServerProvider {
  const discovered = AsyncResult.isSuccess(result) ? result.value.map(toProviderModel) : [];
  const missing = selectedModels
    .filter((slug) => !discovered.some((model) => model.slug === slug))
    .map((slug): ServerProviderModel => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: null,
    }));
  const failure = Option.getOrUndefined(AsyncResult.error(result));
  return {
    instanceId: id,
    driver: textGeneratorBrand(config),
    displayName: textGeneratorDisplayName(config),
    supportsTextGeneration: true,
    enabled: config.enabled,
    installed: true,
    version: null,
    status: failure === undefined ? "ready" : "error",
    ...(failure === undefined ? {} : { message: failure }),
    auth: { status: "unknown" },
    checkedAt: new Date(0).toISOString(),
    models: [...discovered, ...missing],
    slashCommands: [],
    skills: [],
  };
}

/**
 * The environment's text generation providers plus its enabled text generators, for the pickers
 * that may write text. Text generators replace a provider instance with the same id, as the
 * server does. Selections listed in `selections` keep their model while the list loads.
 */
export function useTextGenerationTargets(input: {
  readonly environmentId: EnvironmentId | null;
  readonly settings: Pick<
    ServerSettings,
    "providerInstances" | "projectSettingsOverrides" | "textGenerators"
  >;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly projectId: ProjectId | null;
  readonly selections: ReadonlyArray<ModelSelection | null | undefined>;
}): {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
} {
  const { environmentId, settings } = input;
  const generators =
    environmentId === null
      ? []
      : (
          Object.entries(settings.textGenerators) as Array<
            [ProviderInstanceId, TextGeneratorConfig]
          >
        )
          .filter(([, config]) => config.enabled)
          .map(([id, config]) => ({
            id,
            config,
            key: JSON.stringify([
              environmentId,
              id,
              config.kind,
              config.baseUrl,
              config.apiKey,
            ] satisfies ModelsKey),
          }));
  const results = useAtomValue(
    textGeneratorCatalogAtom(JSON.stringify(generators.map((generator) => generator.key))),
  );
  const generatorProviders = generators.map(({ id, config }, index) =>
    textGeneratorSnapshot(
      id,
      config,
      results[index] ?? AsyncResult.initial(),
      input.selections.flatMap((selection) =>
        selection?.instanceId === id && selection.model ? [selection.model] : [],
      ),
    ),
  );
  const providers = input.providers.filter(
    (provider) => !Object.hasOwn(settings.textGenerators, provider.instanceId),
  );
  return {
    providers: [...providers, ...generatorProviders],
    // Project provider overrides do not apply to text generators, so their entries skip them.
    entries: [
      ...providerInstanceEntriesFor(providers, settings, input.projectId),
      ...deriveProviderInstanceEntries(generatorProviders),
    ],
  };
}
