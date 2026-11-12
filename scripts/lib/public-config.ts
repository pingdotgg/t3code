// @effect-diagnostics nodeBuiltinImport:off - Build bootstrap reads optional root env files before an Effect runtime exists.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

type Environment = Readonly<Record<string, string | undefined>>;

const REPO_ROOT = NodePath.resolve(NodeURL.fileURLToPath(import.meta.url), "../../..");

/** Public build values and the bundler-prefixed names each surface reads them under. */
const PUBLIC_VALUES = [
  ["T3CODE_MOBILE_OTLP_TRACES_URL", "EXPO_PUBLIC_OTLP_TRACES_URL"],
  ["T3CODE_MOBILE_OTLP_TRACES_DATASET", "EXPO_PUBLIC_OTLP_TRACES_DATASET"],
  ["T3CODE_MOBILE_OTLP_TRACES_TOKEN", "EXPO_PUBLIC_OTLP_TRACES_TOKEN"],
] as const;

export function loadRepoEnv({
  baseEnv = process.env,
  repoRoot = REPO_ROOT,
}: {
  readonly baseEnv?: Environment;
  readonly repoRoot?: string;
} = {}): Record<string, string | undefined> {
  const rootEnv = readEnvFile(NodePath.join(repoRoot, ".env"));
  const localEnv = readEnvFile(NodePath.join(repoRoot, ".env.local"));
  const sources = [baseEnv, localEnv, rootEnv];
  const resolved: Record<string, string> = {};
  for (const names of PUBLIC_VALUES) {
    const value = firstNonEmpty(sources, names);
    if (value) for (const name of names) resolved[name] = value;
  }
  return { ...rootEnv, ...localEnv, ...baseEnv, ...resolved };
}

function firstNonEmpty(sources: readonly Environment[], names: readonly string[]) {
  for (const source of sources) {
    for (const name of names) {
      const value = source[name]?.trim();
      if (value) {
        return value;
      }
    }
  }
  return undefined;
}

function readEnvFile(path: string): Record<string, string | undefined> {
  return NodeFS.existsSync(path) ? NodeUtil.parseEnv(NodeFS.readFileSync(path, "utf8")) : {};
}
