import type {
  ServerProviderModel,
  ServerProviderModelCatalog,
  ServerProviderModelGroup,
} from "@t3tools/contracts";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asArray(value: unknown): ReadonlyArray<unknown> | undefined {
  return Array.isArray(value) ? value : undefined;
}

function buildModelSlug(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

function parseProviderGroups(payload: unknown): ReadonlyArray<ServerProviderModelGroup> {
  const providers = asArray(payload) ?? [];
  return providers.flatMap((entry) => {
    const provider = asRecord(entry);
    const providerId = asString(provider?.id);
    const providerName = asString(provider?.name) ?? providerId;
    const models = asRecord(provider?.models);
    if (!providerId || !providerName || !models) {
      return [];
    }

    const parsedModels = Object.values(models).flatMap((value) => {
      const model = asRecord(value);
      const modelId = asString(model?.id);
      const modelName = asString(model?.name) ?? modelId;
      if (!modelId || !modelName) {
        return [];
      }

      return [
        {
          slug: buildModelSlug(providerId, modelId),
          name: modelName,
        } satisfies ServerProviderModel,
      ];
    });

    if (parsedModels.length === 0) {
      return [];
    }

    return [
      {
        id: providerId,
        name: providerName,
        models: parsedModels,
      } satisfies ServerProviderModelGroup,
    ];
  });
}

function flattenProviderGroups(
  groups: ReadonlyArray<ServerProviderModelGroup>,
): ReadonlyArray<ServerProviderModel> {
  return groups.flatMap((group) =>
    group.models.map((model) => ({
      slug: model.slug,
      name: `${group.name} / ${model.name}`,
    })),
  );
}

function parseFavoriteModelSlugs(
  payload: unknown,
  modelBySlug: ReadonlyMap<string, ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  const body = asRecord(payload);
  const favoriteEntries =
    asArray(body?.favorites) ??
    asArray(body?.favoriteModels) ??
    asArray(body?.starred) ??
    asArray(body?.starredModels) ??
    [];

  const matched = new Map<string, ServerProviderModel>();

  for (const entry of favoriteEntries) {
    const resolved = resolveFavoriteModel(entry, modelBySlug);
    if (!resolved) {
      continue;
    }
    matched.set(resolved.slug, resolved);
  }

  return [...matched.values()];
}

function resolveFavoriteModel(
  entry: unknown,
  modelBySlug: ReadonlyMap<string, ServerProviderModel>,
): ServerProviderModel | undefined {
  const direct = asString(entry);
  if (direct) {
    return modelBySlug.get(direct);
  }

  const record = asRecord(entry);
  if (!record) {
    return undefined;
  }

  const slug = asString(record.slug);
  if (slug) {
    return modelBySlug.get(slug);
  }

  const providerId =
    asString(record.providerId) ??
    asString(asRecord(record.provider)?.id) ??
    asString(record.provider);
  const modelId = asString(record.modelId) ?? asString(record.model) ?? asString(record.id);
  if (!providerId || !modelId) {
    return undefined;
  }

  return modelBySlug.get(buildModelSlug(providerId, modelId));
}

function buildCatalogFromGroups(
  payload: unknown,
  groups: ReadonlyArray<ServerProviderModelGroup>,
): {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly modelCatalog?: ServerProviderModelCatalog;
} {
  const models = flattenProviderGroups(groups);
  if (groups.length === 0) {
    return { models };
  }

  const modelBySlug = new Map(models.map((model) => [model.slug, model] as const));
  const favorites = parseFavoriteModelSlugs(payload, modelBySlug);

  return {
    models,
    modelCatalog: {
      groups,
      ...(favorites.length > 0 ? { favorites } : {}),
    },
  };
}

export function parseConnectedOpenCodeModelCatalog(payload: unknown): {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly modelCatalog?: ServerProviderModelCatalog;
} {
  const body = asRecord(payload);
  const all = asArray(body?.all) ?? [];
  const connected = new Set(
    (asArray(body?.connected) ?? [])
      .map((entry) => asString(entry))
      .filter((entry): entry is string => Boolean(entry)),
  );

  if (connected.size === 0) {
    return { models: [] };
  }

  const connectedProviders = all.filter((entry) => {
    const provider = asRecord(entry);
    const id = asString(provider?.id);
    return typeof id === "string" && connected.has(id);
  });

  return buildCatalogFromGroups(payload, parseProviderGroups(connectedProviders));
}

export function parseConfiguredOpenCodeModelCatalog(payload: unknown): {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly modelCatalog?: ServerProviderModelCatalog;
} {
  const body = asRecord(payload);
  const providers = asArray(body?.providers) ?? asArray(payload) ?? [];
  return buildCatalogFromGroups(payload, parseProviderGroups(providers));
}
