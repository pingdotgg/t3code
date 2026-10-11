import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

export const ProviderOptionDescriptorType = Schema.Literals(["select", "boolean"]);
export type ProviderOptionDescriptorType = typeof ProviderOptionDescriptorType.Type;

export const ProviderOptionChoice = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  isDefault: Schema.optional(Schema.Boolean),
});
export type ProviderOptionChoice = typeof ProviderOptionChoice.Type;

const ProviderOptionDescriptorBase = {
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
} as const;

export const SelectProviderOptionDescriptor = Schema.Struct({
  ...ProviderOptionDescriptorBase,
  type: Schema.Literal("select"),
  options: Schema.Array(ProviderOptionChoice),
  currentValue: Schema.optional(TrimmedNonEmptyString),
  promptInjectedValues: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});
export type SelectProviderOptionDescriptor = typeof SelectProviderOptionDescriptor.Type;

export const BooleanProviderOptionDescriptor = Schema.Struct({
  ...ProviderOptionDescriptorBase,
  type: Schema.Literal("boolean"),
  currentValue: Schema.optional(Schema.Boolean),
});
export type BooleanProviderOptionDescriptor = typeof BooleanProviderOptionDescriptor.Type;

export const ProviderOptionDescriptor = Schema.Union([
  SelectProviderOptionDescriptor,
  BooleanProviderOptionDescriptor,
]);
export type ProviderOptionDescriptor = typeof ProviderOptionDescriptor.Type;

export const ProviderOptionSelectionValue = Schema.Union([TrimmedNonEmptyString, Schema.Boolean]);
export type ProviderOptionSelectionValue = typeof ProviderOptionSelectionValue.Type;

export const ProviderOptionSelection = Schema.Struct({
  id: TrimmedNonEmptyString,
  value: ProviderOptionSelectionValue,
});
export type ProviderOptionSelection = typeof ProviderOptionSelection.Type;

/**
 * Boolean model option that runs a thread's turns in the provider's cloud
 * instead of on its environment. Clients set it from the Cloud entry under
 * Run on, offered when the provider snapshot has `cloudRun`; it is never a
 * model trait, so option editors that rebuild a selection must carry it over.
 */
const CLOUD_RUN_OPTION_ID = "cloud";
const CLOUD_ENVIRONMENT_OPTION_ID = "cloudEnvironment";
/**
 * Marks the conversation that sets up or edits a Codex Cloud environment with
 * the `$cloud-environment-onboarding:setup` skill. Only these threads offer
 * Edit and Publish environment.
 */
const CLOUD_ENVIRONMENT_SETUP_OPTION_ID = "cloudEnvironmentSetup";

/** Whether an option belongs to the run location rather than the model. */
export const isCloudRunOption = (option: ProviderOptionSelection): boolean =>
  option.id === CLOUD_RUN_OPTION_ID ||
  option.id === CLOUD_ENVIRONMENT_OPTION_ID ||
  option.id === CLOUD_ENVIRONMENT_SETUP_OPTION_ID;

/** Whether a selection's options mark a cloud environment setup conversation. */
export const selectsCloudEnvironmentSetup = (
  options: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): boolean =>
  options?.some(
    (option) => option.id === CLOUD_ENVIRONMENT_SETUP_OPTION_ID && option.value === true,
  ) ?? false;

/** The Codex Cloud destination saved with a thread's model selection. */
export function selectedCloudEnvironment(
  options: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): string | undefined {
  const value = options?.find((option) => option.id === CLOUD_ENVIRONMENT_OPTION_ID)?.value;
  return typeof value === "string" ? value : undefined;
}

/** Where a selection runs in the cloud; `null` runs it on its machine. */
interface CloudRunPlacement {
  readonly environment?: string | undefined;
  readonly setup?: boolean | undefined;
}

/** Replaces a selection's run location options, keeping its model traits. */
export function withCloudRunOptions(
  options: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  placement: CloudRunPlacement | null,
): Array<ProviderOptionSelection> {
  return [
    ...(options ?? []).filter((option) => !isCloudRunOption(option)),
    ...(placement
      ? [
          { id: CLOUD_RUN_OPTION_ID, value: true },
          ...(placement.environment
            ? [{ id: CLOUD_ENVIRONMENT_OPTION_ID, value: placement.environment }]
            : []),
          ...(placement.setup ? [{ id: CLOUD_ENVIRONMENT_SETUP_OPTION_ID, value: true }] : []),
        ]
      : []),
  ];
}

/** Carries run location options through editors that only know model traits. */
export function keepCloudRunOptions(
  next: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  current: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  if (!selectsCloudRun(current)) return next ?? undefined;
  return withCloudRunOptions(next, {
    environment: selectedCloudEnvironment(next) ?? selectedCloudEnvironment(current),
    setup: selectsCloudEnvironmentSetup(current),
  });
}

/** Whether a Codex Cloud environment id names an editable configuration, which can be set up and published. */
export const isCloudEnvironmentConfig = (id: string | null | undefined): id is string =>
  /(?:^|~)asenvcfg_/.test(id ?? "");

/** Whether a selection's options ask for the provider's cloud. */
export const selectsCloudRun = (
  options: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): boolean =>
  options?.some((option) => option.id === CLOUD_RUN_OPTION_ID && option.value === true) ?? false;

/**
 * Legacy on-disk shape for provider option selections, kept readable by the
 * decoder so we can tolerate stored data written before the v3 array shape.
 *
 * Persisted historically as `{ effort: "max", fastMode: true, ... }` inside
 * `modelSelection.options`. Migration 026 rewrites stored rows to the
 * canonical array shape, but we still see the legacy form in:
 *   - `settings.json` files from older client builds,
 *   - SQLite databases that have not yet run migration 026,
 *   - any future regression that re-introduces the legacy shape.
 */
const LegacyProviderOptionSelectionsObject = Schema.Record(Schema.String, Schema.Unknown);

const ProviderOptionSelectionsFromLegacyObject = LegacyProviderOptionSelectionsObject.pipe(
  Schema.decodeTo(
    Schema.Array(ProviderOptionSelection),
    SchemaTransformation.transformEffect({
      decode: (record) => Effect.succeed(coerceLegacyOptionsObjectToArray(record)),
      encode: (selections) => Effect.succeed(canonicalSelectionsToLegacyObject(selections)),
    }),
  ),
);

/**
 * Schema for the `options` field of every `ModelSelection` variant.
 *
 * Accepts both:
 *   - the canonical array shape `Array<{ id, value }>` (preferred), and
 *   - the legacy object shape `Record<string, string | boolean | …>` from
 *     pre-migration data.
 *
 * Always normalizes to the canonical array on decode and re-encodes as the
 * canonical array, so any legacy storage gets cleaned up the next time the
 * containing record is written back.
 */
export const ProviderOptionSelections = Schema.Union([
  Schema.Array(ProviderOptionSelection),
  ProviderOptionSelectionsFromLegacyObject,
]);
export type ProviderOptionSelections = typeof ProviderOptionSelections.Type;

function coerceLegacyOptionsObjectToArray(
  record: Record<string, unknown>,
): ReadonlyArray<ProviderOptionSelection> {
  const entries: Array<ProviderOptionSelection> = [];
  for (const [rawKey, rawValue] of Object.entries(record)) {
    const id = typeof rawKey === "string" ? rawKey.trim() : "";
    if (id.length === 0) continue;
    if (typeof rawValue === "string") {
      const trimmed = rawValue.trim();
      if (trimmed.length > 0) entries.push({ id, value: trimmed });
    } else if (typeof rawValue === "boolean") {
      entries.push({ id, value: rawValue });
    }
    // Drop anything else (numbers, null, nested objects/arrays) to match the
    // permissive normalization performed by migration 026.
  }
  return entries;
}

function canonicalSelectionsToLegacyObject(
  selections: ReadonlyArray<ProviderOptionSelection>,
): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const { id, value } of selections) {
    out[id] = value;
  }
  return out;
}

export const ModelCapabilities = Schema.Struct({
  optionDescriptors: Schema.optional(Schema.Array(ProviderOptionDescriptor)),
});
export type ModelCapabilities = typeof ModelCapabilities.Type;

/**
 * A user-authored custom model. `name` and `capabilities` are optional so a
 * bare slug keeps its driver-default presentation; when `capabilities` is
 * set, its descriptors replace the driver default in the model picker.
 */
export const CustomModelEntry = Schema.Struct({
  slug: TrimmedNonEmptyString,
  name: Schema.optional(TrimmedNonEmptyString),
  capabilities: Schema.optional(ModelCapabilities),
});
export type CustomModelEntry = typeof CustomModelEntry.Type;

/** On-disk custom model setting: the legacy bare slug, or a full entry. */
export const CustomModelSetting = Schema.Union([Schema.String, CustomModelEntry]);
export type CustomModelSetting = typeof CustomModelSetting.Type;

const CODEX_DRIVER_KIND = ProviderDriverKind.make("codex");
const CLAUDE_DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
const CURSOR_DRIVER_KIND = ProviderDriverKind.make("cursor");
const GROK_DRIVER_KIND = ProviderDriverKind.make("grok");
const MUSE_DRIVER_KIND = ProviderDriverKind.make("muse");
const PI_DRIVER_KIND = ProviderDriverKind.make("pi");
const ACP_REGISTRY_DRIVER_KIND = ProviderDriverKind.make("acpRegistry");
const OPENCODE_DRIVER_KIND = ProviderDriverKind.make("opencode");

export const DEFAULT_MODEL = "gpt-6-astra";

/**
 * Codex default-model preference, most preferred first. The provider snapshot
 * marks the first of these present in the live `model/list` response as
 * default; when none are available, Codex's own `isDefault` flag wins.
 */
export const PREFERRED_DEFAULT_CODEX_MODELS: ReadonlyArray<string> = [
  DEFAULT_MODEL,
  "gpt-5.6-sol",
  "gpt-5.6-terra",
];
export const DEFAULT_TEXT_GENERATION_MODEL = "gpt-6-luna";
/** Keep the official Antigravity session's current model. Never send this ID to ACP. */
export const ANTIGRAVITY_DEFAULT_MODEL = "antigravity-default";
export const DEFAULT_TEXT_GENERATION_REASONING_EFFORT = "low";

/** Let Muse pick the account's default model. Never send this ID to Muse. */
export const MUSE_DEFAULT_MODEL = "default";

export const DEFAULT_MODEL_BY_PROVIDER: Partial<Record<ProviderDriverKind, string>> = {
  [CODEX_DRIVER_KIND]: DEFAULT_MODEL,
  [CLAUDE_DRIVER_KIND]: "claude-fable-5-1",
  [CURSOR_DRIVER_KIND]: "auto",
  // Product slug, not an ACP model id. The Grok adapter treats it as "the session's current model".
  [GROK_DRIVER_KIND]: "grok-build",
  [MUSE_DRIVER_KIND]: MUSE_DEFAULT_MODEL,
  [ACP_REGISTRY_DRIVER_KIND]: "default",
  // "default" defers to the user's own Pi settings.json model selection.
  [PI_DRIVER_KIND]: "default",
  [OPENCODE_DRIVER_KIND]: "openai/gpt-5",
  [ProviderDriverKind.make("antigravity")]: ANTIGRAVITY_DEFAULT_MODEL,
};

/** Per-provider text generation model defaults. */
export const DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER: Partial<
  Record<ProviderDriverKind, string>
> = {
  [CODEX_DRIVER_KIND]: DEFAULT_TEXT_GENERATION_MODEL,
  [ProviderDriverKind.make("antigravity")]: ANTIGRAVITY_DEFAULT_MODEL,
  [CLAUDE_DRIVER_KIND]: "claude-haiku-4-5",
  [CURSOR_DRIVER_KIND]: "composer-2",
  [OPENCODE_DRIVER_KIND]: "openai/gpt-5",
};

export const MODEL_SLUG_ALIASES_BY_PROVIDER: Partial<
  Record<ProviderDriverKind, Record<string, string>>
> = {
  [CODEX_DRIVER_KIND]: {
    "gpt-5-codex": "gpt-5.4",
    "5.4": "gpt-5.4",
    "5.3": "gpt-5.3-codex",
    "gpt-5.3": "gpt-5.3-codex",
    "5.3-spark": "gpt-5.3-codex-spark",
    "gpt-5.3-spark": "gpt-5.3-codex-spark",
  },
  [CLAUDE_DRIVER_KIND]: {},
  [CURSOR_DRIVER_KIND]: {
    composer: "composer-2",
    "composer-1.5": "composer-1.5",
    "composer-1": "composer-1.5",
    "opus-4.6-thinking": "claude-opus-4-6",
    "opus-4.6": "claude-opus-4-6",
    "sonnet-4.6-thinking": "claude-sonnet-4-6",
    "sonnet-4.6": "claude-sonnet-4-6",
    "opus-4.5-thinking": "claude-opus-4-5",
    "opus-4.5": "claude-opus-4-5",
  },
  [OPENCODE_DRIVER_KIND]: {},
};

// ── Provider display names ────────────────────────────────────────────

export const PROVIDER_DISPLAY_NAMES: Partial<Record<ProviderDriverKind, string>> = {
  [ProviderDriverKind.make("antigravity")]: "Antigravity",
  [CODEX_DRIVER_KIND]: "Codex",
  [CLAUDE_DRIVER_KIND]: "Claude",
  [CURSOR_DRIVER_KIND]: "Cursor",
  [GROK_DRIVER_KIND]: "Grok",
  [MUSE_DRIVER_KIND]: "Muse Code",
  [ACP_REGISTRY_DRIVER_KIND]: "ACP Registry",
  [PI_DRIVER_KIND]: "Pi",
  [OPENCODE_DRIVER_KIND]: "OpenCode",
};
