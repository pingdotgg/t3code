/**
 * Flexible system prompt injection (fork feature f2).
 *
 * A user keeps an ordered list of rules; the rules whose match narrows to a
 * session's target are composed into one instruction block that the server
 * hands to the provider's native instruction slot when the session starts.
 *
 * The resolver lives in contracts rather than the server because the settings
 * preview has to render byte-identical text to what actually ships. Both the
 * client preview and `SystemPromptResolver` call
 * `resolveSystemPromptInjection`, so the two cannot drift.
 *
 * Wire note: every match field is an open branded slug or a free string. A
 * closed `Schema.Literals` here would ride inside `ServerSettings` and break
 * an older client's decode of the whole settings payload the first time the
 * matching vocabulary grew.
 *
 * @module systemPrompt
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

/**
 * Constraints a rule places on the session it applies to. An absent
 * constraint matches anything, so `{}` is the global rule.
 */
export const SystemPromptRuleMatch = Schema.Struct({
  driverKind: Schema.optionalKey(ProviderDriverKind),
  instanceId: Schema.optionalKey(ProviderInstanceId),
  /** Matched with a minimal `*` glob, case-insensitively. */
  modelSlug: Schema.optionalKey(TrimmedNonEmptyString),
  /** Carries `ProviderInteractionMode` values, typed as a free string so the
      settings payload stays decodable when that vocabulary grows. */
  interactionMode: Schema.optionalKey(TrimmedNonEmptyString),
});
export type SystemPromptRuleMatch = typeof SystemPromptRuleMatch.Type;

export const SystemPromptRule = Schema.Struct({
  /** Client-generated and stable across edits; used as the React key. */
  id: TrimmedNonEmptyString,
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  match: SystemPromptRuleMatch.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  text: TrimmedString,
});
export type SystemPromptRule = typeof SystemPromptRule.Type;

/** Array order is composition order. */
export const SystemPromptInjectionSettings = Schema.Struct({
  schemaVersion: Schema.Literal(1).pipe(Schema.withDecodingDefault(Effect.succeed(1 as const))),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  rules: Schema.Array(SystemPromptRule).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type SystemPromptInjectionSettings = typeof SystemPromptInjectionSettings.Type;

/**
 * What a provider does with injected instructions. `session` attaches them
 * once when the session opens; `turn` would attach them per turn; nothing is
 * sent to an `unsupported` provider, and the settings UI says so rather than
 * quietly prepending the text to the user's first message.
 */
export type SystemPromptInjectionSupport = "session" | "turn" | "unsupported";

/**
 * Mirrors the `instructionInjection` capability each server adapter declares.
 * The adapters are authoritative — this map exists so the settings preview can
 * tell the user what a given instance will actually receive. A driver this
 * build has never heard of reads as `unsupported`, which is the answer that
 * cannot mislead.
 */
export const SYSTEM_PROMPT_INJECTION_SUPPORT_BY_DRIVER: Readonly<
  Record<string, SystemPromptInjectionSupport>
> = {
  claudeAgent: "session",
  codex: "session",
  cursor: "unsupported",
  grok: "unsupported",
  opencode: "unsupported",
};

export function systemPromptInjectionSupport(driverKind: string): SystemPromptInjectionSupport {
  return SYSTEM_PROMPT_INJECTION_SUPPORT_BY_DRIVER[driverKind] ?? "unsupported";
}

/** The session a rule set is being resolved for. */
export interface SystemPromptTarget {
  readonly driverKind: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly modelSlug?: string | undefined;
  readonly interactionMode?: string | undefined;
}

const GLOB_SPECIALS = /[.*+?^${}()|[\]\\]/g;

function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .split("*")
    .map((segment) => segment.replace(GLOB_SPECIALS, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`, "i");
}

function matchesModelSlug(pattern: string, slug: string | undefined): boolean {
  if (slug === undefined) {
    return false;
  }
  return globToRegExp(pattern).test(slug);
}

function matchesTarget(match: SystemPromptRuleMatch, target: SystemPromptTarget): boolean {
  if (match.driverKind !== undefined && match.driverKind !== target.driverKind) {
    return false;
  }
  if (match.instanceId !== undefined && match.instanceId !== target.instanceId) {
    return false;
  }
  if (match.interactionMode !== undefined && match.interactionMode !== target.interactionMode) {
    return false;
  }
  if (match.modelSlug !== undefined && !matchesModelSlug(match.modelSlug, target.modelSlug)) {
    return false;
  }
  return true;
}

/**
 * Rules that apply to `target`, in declaration order, with disabled rules
 * dropped. A rule applies when every constraint it states matches; a
 * constraint it omits matches anything.
 *
 * The master `enabled` switch is deliberately not consulted here — that is
 * `resolveSystemPromptInjection`'s job, so this stays a pure question about
 * matching.
 */
export function selectSystemPromptRules(
  settings: SystemPromptInjectionSettings,
  target: SystemPromptTarget,
): ReadonlyArray<SystemPromptRule> {
  return settings.rules.filter((rule) => rule.enabled && matchesTarget(rule.match, target));
}

/** Blank-line separated join of the trimmed, non-empty segments. */
export function composeSystemPromptText(
  segments: ReadonlyArray<string | undefined>,
): string | undefined {
  const parts: Array<string> = [];
  for (const segment of segments) {
    const trimmed = segment?.trim() ?? "";
    if (trimmed.length > 0) {
      parts.push(trimmed);
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/**
 * The one function both the injection path and the settings preview call.
 * Returns `undefined` when injection is off or nothing matched, which every
 * caller reads as "attach no instructions".
 */
export function resolveSystemPromptInjection(
  settings: SystemPromptInjectionSettings,
  target: SystemPromptTarget,
): string | undefined {
  if (!settings.enabled) {
    return undefined;
  }
  return composeSystemPromptText(
    selectSystemPromptRules(settings, target).map((rule) => rule.text),
  );
}
