import { ProviderDriverKind } from "@t3tools/contracts";
import {
  AntigravityIcon,
  ClaudeAI,
  CognitionIcon,
  CursorIcon,
  DeepSeekIcon,
  DevinIcon,
  Gemini,
  GLMIcon,
  GrokIcon,
  Icon,
  KimiIcon,
  NvidiaIcon,
  OpenAI,
  OpenCodeIcon,
} from "../Icons";
import { PROVIDER_OPTIONS } from "../../session-logic";

export const PROVIDER_ICON_BY_PROVIDER: Partial<Record<ProviderDriverKind, Icon>> = {
  [ProviderDriverKind.make("codex")]: OpenAI,
  [ProviderDriverKind.make("claudeAgent")]: ClaudeAI,
  [ProviderDriverKind.make("opencode")]: OpenCodeIcon,
  [ProviderDriverKind.make("cursor")]: CursorIcon,
  [ProviderDriverKind.make("devin")]: DevinIcon,
  [ProviderDriverKind.make("grok")]: GrokIcon,
  [ProviderDriverKind.make("antigravity")]: AntigravityIcon,
};

export type ModelEsque = {
  slug: string;
  name: string;
  shortName?: string | undefined;
  subProvider?: string | undefined;
  aliases?: ReadonlyArray<string> | undefined;
  isDefault?: boolean | undefined;
  badge?: "new" | undefined;
  isLegacy?: boolean | undefined;
  isUnavailable?: boolean | undefined;
};

export type ModelProviderBrand = {
  readonly label: string;
  readonly icon: Icon;
};

function modelIdentity(model: ModelEsque): string {
  return `${model.slug} ${model.name} ${model.subProvider ?? ""}`.toLowerCase();
}

/** Resolve the company behind a model exposed through Devin. */
export function getDevinModelProviderBrand(model: ModelEsque): ModelProviderBrand {
  const identity = modelIdentity(model);
  if (identity.includes("claude") || identity.includes("anthropic")) {
    return { label: "Anthropic", icon: ClaudeAI };
  }
  if (identity.includes("gpt") || identity.includes("openai") || identity.includes("codex")) {
    return { label: "OpenAI", icon: OpenAI };
  }
  if (identity.includes("gemini") || identity.includes("google")) {
    return { label: "Google", icon: Gemini };
  }
  if (identity.includes("glm") || identity.includes("zhipu") || identity.includes("z.ai")) {
    return { label: "Z.ai", icon: GLMIcon };
  }
  if (identity.includes("kimi") || identity.includes("moonshot")) {
    return { label: "Moonshot AI", icon: KimiIcon };
  }
  if (identity.includes("deepseek")) {
    return { label: "DeepSeek", icon: DeepSeekIcon };
  }
  if (identity.includes("grok") || identity.includes("xai")) {
    return { label: "xAI", icon: GrokIcon };
  }
  if (identity.includes("nemotron") || identity.includes("nvidia")) {
    return { label: "NVIDIA", icon: NvidiaIcon };
  }
  if (identity.includes("swe-") || identity.includes("adaptive") || identity.includes("inkling")) {
    return { label: "Cognition", icon: CognitionIcon };
  }
  return { label: "Devin", icon: DevinIcon };
}

export function getModelProviderBrand(
  driverKind: ProviderDriverKind,
  model: ModelEsque,
): ModelProviderBrand {
  if (driverKind === ProviderDriverKind.make("devin")) {
    return getDevinModelProviderBrand(model);
  }
  return {
    label: PROVIDER_OPTIONS.find((option) => option.value === driverKind)?.label ?? driverKind,
    icon: PROVIDER_ICON_BY_PROVIDER[driverKind] ?? DevinIcon,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingQualifier(value: string, qualifier: string | null | undefined): string {
  const trimmedQualifier = qualifier?.trim();
  if (!trimmedQualifier) {
    return value;
  }

  const pattern = new RegExp(`^${escapeRegExp(trimmedQualifier)}(?:\\s*[.:/-]\\s*|\\s+)`, "iu");
  return value.replace(pattern, "").trim() || value;
}

export function getDisplayModelName(
  model: ModelEsque,
  options?: { preferShortName?: boolean },
): string {
  const name = options?.preferShortName && model.shortName ? model.shortName : model.name;
  return stripLeadingQualifier(name, model.subProvider);
}

export function getTriggerDisplayModelName(model: ModelEsque): string {
  return getDisplayModelName(model, { preferShortName: true });
}

export function getTriggerDisplayModelLabel(model: ModelEsque): string {
  return getTriggerDisplayModelName(model);
}
