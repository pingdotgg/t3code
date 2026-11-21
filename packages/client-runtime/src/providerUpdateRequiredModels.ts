import { PROVIDER_DISPLAY_NAMES, type ServerProvider } from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { mFallback, msg } from "gt-i18n";
import { formatConjunctionList } from "./listFormat.ts";
import type { MFunctionType } from "gt-i18n/types";

const CLAUDE_CODE_NAME = "Claude Code";

export function formatProviderUpdateRequiredNotice(
  provider: Pick<ServerProvider, "driver" | "updateRequiredModels">,
  searchQuery = "",
  resolve: MFunctionType = mFallback,
  locale = "en",
): string | null {
  const query = searchQuery.trim().toLocaleLowerCase();
  const models = (provider.updateRequiredModels ?? []).filter(
    (model) =>
      query.length === 0 ||
      model.name.toLocaleLowerCase().includes(query) ||
      model.slug.toLocaleLowerCase().includes(query),
  );
  if (models.length === 0) return null;
  const minVersion = models
    .map((model) => model.minVersion)
    .reduce((highest, version) =>
      compareSemverVersions(version, highest) > 0 ? version : highest,
    );
  const providerName =
    provider.driver === "claudeAgent"
      ? CLAUDE_CODE_NAME
      : (PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver);
  const version = minVersion.startsWith("v") ? minVersion : `v${minVersion}`;
  const names = formatConjunctionList(
    models.map((model) => model.name),
    locale,
    resolve,
  );
  return resolve(
    msg(
      "{runtime, select, codex {Update the Codex CLI to {version} or newer to use {names}.} other {Update {providerName} to {version} or newer to use {names}.}}",
      {
        runtime: provider.driver === "codex" ? "codex" : "other",
        providerName,
        version,
        names,
      },
    ),
  );
}

/** Explains models the account's organization turned off, which pickers never list. */
export function formatProviderRestrictedModelsNotice(
  provider: Pick<ServerProvider, "restrictedModels">,
  searchQuery = "",
  resolve: MFunctionType = mFallback,
  locale = "en",
): string | null {
  const query = searchQuery.trim().toLocaleLowerCase();
  const models = (provider.restrictedModels ?? []).filter(
    (model) =>
      query.length === 0 ||
      model.name.toLocaleLowerCase().includes(query) ||
      model.slug.toLocaleLowerCase().includes(query),
  );
  if (models.length === 0) return null;
  const names = formatConjunctionList(
    models.map((model) => model.name),
    locale,
    resolve,
  );
  return resolve(msg("Your organization has turned off {names}.", { names }));
}
