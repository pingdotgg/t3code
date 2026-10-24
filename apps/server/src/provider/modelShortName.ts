import type { ServerProvider } from "@t3tools/contracts";

const MODEL_FAMILIES: ReadonlyArray<{
  readonly prefix: string;
  readonly nativeDrivers: ReadonlyArray<string>;
}> = [
  { prefix: "Claude ", nativeDrivers: ["claudeAgent"] },
  { prefix: "GPT-", nativeDrivers: ["codex"] },
  { prefix: "Gemini ", nativeDrivers: ["antigravity"] },
  { prefix: "Muse ", nativeDrivers: ["muse"] },
  { prefix: "Grok ", nativeDrivers: ["grok", "cursor"] },
];

// Words that describe a variant within a family rather than name a model. Off the
// family's native provider there is no icon saying which family "4 Pro" belongs to.
const VARIANT_WORDS = new Set([
  "pro",
  "flash",
  "mini",
  "max",
  "lite",
  "nano",
  "ultra",
  "plus",
  "fast",
  "turbo",
  "preview",
  "latest",
  "thinking",
  "reasoning",
  "build",
  "image",
  "vision",
  "audio",
  "live",
  "custom",
  "tools",
  "exp",
  "experimental",
  "chat",
  "tts",
  "stt",
  "non",
  "transcribe",
]);

const VERSION = /^v?\d+(?:\.\d+)*[a-z]?$/i;

const VENDOR_PREFIX = /^[A-Z][\w.&\- ]{0,24}: (?=\S)/;

export function modelShortName(name: string, driver: string): string | undefined {
  const unprefixed = name.replace(VENDOR_PREFIX, "");
  const short = withoutFamily(unprefixed, driver) ?? (namesModel(unprefixed) ? unprefixed : name);
  return short === name ? undefined : short;
}

function withoutFamily(name: string, driver: string): string | undefined {
  const family = MODEL_FAMILIES.find((candidate) => name.startsWith(candidate.prefix));
  if (!family) return undefined;
  const rest = name.slice(family.prefix.length).trim();
  const named = nonVersionWords(rest);
  if (named.length === 0) return undefined;
  if (!family.nativeDrivers.includes(driver) && !namesModel(rest)) return undefined;
  return /\s/.test(rest) ? rest : rest.replaceAll("-", " ");
}

function nonVersionWords(text: string): ReadonlyArray<string> {
  return text
    .replace(/\(.*?\)/g, " ")
    .split(/[\s-]+/)
    .filter((word) => word.length > 0 && !VERSION.test(word));
}

function namesModel(text: string): boolean {
  return nonVersionWords(text).some((word) => !VARIANT_WORDS.has(word.toLowerCase()));
}

export function withModelShortNames(provider: ServerProvider): ServerProvider {
  let changed = false;
  const models = provider.models.map((model) => {
    if (model.shortName) return model;
    const shortName = modelShortName(model.name, provider.driver);
    if (!shortName) return model;
    changed = true;
    return { ...model, shortName };
  });
  return changed ? { ...provider, models } : provider;
}
