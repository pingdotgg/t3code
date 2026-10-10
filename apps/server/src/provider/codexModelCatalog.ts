/**
 * Codex's view of its manifest catalog. Codex discovers models from its app
 * server, so the catalog only reclassifies them, moves the default, and names
 * models a newer Codex build would unlock.
 *
 * @module provider/codexModelCatalog
 */
import type { ServerProviderUpdateRequiredModel } from "@t3tools/contracts";
import * as ModelCatalog from "@t3tools/provider-core/server/ModelCatalog";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import { codexModelFamily } from "@t3tools/shared/model";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "@t3tools/contracts";

/** Dated Codex builds match their base model's catalog entry. */
const CODEX_MATCHING: ModelCatalog.CatalogMatching = { family: codexModelFamily };

const CodexModelAdapter = Schema.Struct({
  codex: Schema.optional(Schema.Struct({ minVersion: Schema.optional(TrimmedNonEmptyString) })),
});
const decodeCodexModelAdapter = Schema.decodeUnknownOption(CodexModelAdapter);

/**
 * Codex lists only the models its own build knows, so a model released after
 * the installed CLI never shows up. A current catalog entry with
 * `adapter.codex.minVersion` names that model, letting the picker say an update
 * unlocks it instead of leaving users to wonder where it is.
 */
function codexUpdateRequiredModels(
  catalog: ModelCatalog.ProviderCatalog | undefined,
  draft: ServerProviderDraft,
): ReadonlyArray<ServerProviderUpdateRequiredModel> {
  const version = draft.version?.replace(/^v/, "");
  if (!catalog || !version || parseSemver(version) === null) return [];
  const discovered = new Set(draft.models.map((model) => codexModelFamily(model.slug)));
  return catalog.models.flatMap((entry) => {
    if (entry.status !== "current" || discovered.has(codexModelFamily(entry.slug))) return [];
    const minVersion = Option.getOrUndefined(decodeCodexModelAdapter(entry.adapter ?? {}))?.codex
      ?.minVersion;
    if (!minVersion || parseSemver(minVersion) === null) return [];
    if (compareSemverVersions(version, minVersion) >= 0) return [];
    return [
      {
        slug: entry.slug,
        name: entry.name,
        ...(entry.badge ? { badge: entry.badge } : {}),
        minVersion,
      },
    ];
  });
}

/** Reclassifies a Codex snapshot draft's models against its catalog. */
export function applyCodexModelCatalog(
  draft: ServerProviderDraft,
  catalog: ModelCatalog.ProviderCatalog | undefined,
): ServerProviderDraft {
  const updateRequiredModels = codexUpdateRequiredModels(catalog, draft);
  return {
    ...ModelCatalog.applyModelCatalog(draft, catalog, CODEX_MATCHING),
    ...(updateRequiredModels.length > 0 ? { updateRequiredModels } : {}),
  };
}
