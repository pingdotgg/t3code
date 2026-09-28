import {
  CURSOR_CLOUD_DEFAULT_MODEL,
  type ProviderOptionDescriptor,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";

import {
  CURSOR_CLOUD_API_KEY_ENV,
  type CursorCloudModel,
  makeCursorCloudApi,
} from "../cursorCloudApi.ts";

type CursorCloudStatus = NonNullable<ServerProvider["cloud"]>;

const DEFAULT_MODEL: ServerProviderModel = {
  slug: CURSOR_CLOUD_DEFAULT_MODEL,
  name: "Default",
  isCustom: false,
  isDefault: true,
  capabilities: createModelCapabilities({ optionDescriptors: [] }),
};

export const CURSOR_CLOUD_MISSING_KEY_MESSAGE = `Add a Cursor API key as the ${CURSOR_CLOUD_API_KEY_ENV} environment variable on this provider. Create one in the Cursor dashboard under API Keys.`;

export function resolveCursorCloudApiKey(environment: NodeJS.ProcessEnv): string | undefined {
  return environment[CURSOR_CLOUD_API_KEY_ENV]?.trim() || undefined;
}

function optionDescriptorsForModel(
  model: CursorCloudModel,
): ReadonlyArray<ProviderOptionDescriptor> {
  const defaults = model.variants?.find((variant) => variant.isDefault)?.params ?? [];
  return (model.parameters ?? []).flatMap((parameter): ProviderOptionDescriptor[] => {
    const values = parameter.values.map((entry) => entry.value);
    if (values.length === 0) return [];
    const label = parameter.displayName?.trim() || parameter.id;
    const defaultValue = defaults.find((param) => param.id === parameter.id)?.value;
    if (values.length === 2 && values.includes("true") && values.includes("false")) {
      return [
        {
          id: parameter.id,
          label,
          type: "boolean",
          ...(defaultValue !== undefined ? { currentValue: defaultValue === "true" } : {}),
        },
      ];
    }
    return [
      {
        id: parameter.id,
        label,
        type: "select",
        options: parameter.values.map((entry) => ({
          id: entry.value,
          label: entry.displayName?.trim() || entry.value,
          ...(entry.value === defaultValue ? { isDefault: true } : {}),
        })),
        ...(defaultValue !== undefined ? { currentValue: defaultValue } : {}),
      },
    ];
  });
}

/** The account's default first, then every model `/v1/models` recommends. */
function cursorCloudModelsFromApi(
  models: ReadonlyArray<CursorCloudModel>,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>([CURSOR_CLOUD_DEFAULT_MODEL]);
  const listed = models.flatMap((model): ServerProviderModel[] => {
    const slug = model.id.trim();
    if (!slug || seen.has(slug)) return [];
    seen.add(slug);
    return [
      {
        slug,
        name: model.displayName?.trim() || slug,
        isCustom: false,
        capabilities: createModelCapabilities({
          optionDescriptors: optionDescriptorsForModel(model),
        }),
      },
    ];
  });
  return [DEFAULT_MODEL, ...listed];
}

/**
 * Whether this Cursor instance can run cloud threads. Validates the key with
 * `/v1/me` and reads the cloud model catalog; never starts an agent.
 */
export const checkCursorCloudStatus = Effect.fn("checkCursorCloudStatus")(function* (
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<CursorCloudStatus, never, HttpClient.HttpClient> {
  const apiKey = resolveCursorCloudApiKey(environment);
  if (!apiKey) {
    return { available: false, message: CURSOR_CLOUD_MISSING_KEY_MESSAGE, models: [] };
  }

  const api = makeCursorCloudApi({ apiKey, httpClient: yield* HttpClient.HttpClient });
  const me = yield* Effect.result(api.me);
  if (Result.isFailure(me)) {
    const rejected = me.failure.status === 401 || me.failure.status === 403;
    return {
      available: false,
      message: rejected
        ? `Cursor rejected the ${CURSOR_CLOUD_API_KEY_ENV} API key.`
        : `Could not reach Cursor Cloud: ${me.failure.detail}`,
      models: [],
    };
  }

  const models = yield* Effect.result(api.listModels);
  if (Result.isFailure(models)) {
    yield* Effect.logWarning("Cursor Cloud model listing failed.", {
      status: models.failure.status,
    });
    return {
      available: true,
      message: "Cursor Cloud's model list could not be loaded. New threads use your default model.",
      models: [DEFAULT_MODEL],
    };
  }
  return { available: true, models: cursorCloudModelsFromApi(models.success) };
});
