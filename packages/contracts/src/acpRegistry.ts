/**
 * ACP Registry contracts.
 *
 * T3 Code's extra-provider path follows Paseo: native drivers stay first-class
 * (Codex, Claude, Cursor, Grok, OpenCode), and every other ACP-speaking CLI is
 * one generic `acpRegistry` driver plus a catalog of launch specs.
 *
 * Featured entries are the in-app one-click list (Gemini, Copilot, Pi, …).
 * The live ACP registry index is the same JSON clients fetch from
 * `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`.
 * Adding another agent is a catalog row, not a new driver.
 *
 * @module acpRegistry
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ACP_REGISTRY_DRIVER_KIND = "acpRegistry" as const;
export const ACP_REGISTRY_INDEX_URL =
  "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

export const AcpRegistryCatalogIconKey = Schema.Literals([
  "acpRegistry",
  "gemini",
  "githubCopilot",
  "piAgent",
]);
export type AcpRegistryCatalogIconKey = typeof AcpRegistryCatalogIconKey.Type;

export const AcpRegistryDistributionType = Schema.Literals(["local", "npx", "uvx", "unsupported"]);
export type AcpRegistryDistributionType = typeof AcpRegistryDistributionType.Type;

export const AcpRegistryLaunchSpec = Schema.Struct({
  command: TrimmedNonEmptyString,
  args: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type AcpRegistryLaunchSpec = typeof AcpRegistryLaunchSpec.Type;

export interface AcpRegistryFeaturedLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export interface AcpRegistryFeaturedAgent {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly docsUrl?: string;
  readonly installHint: string;
  readonly iconKey: AcpRegistryCatalogIconKey;
  readonly local?: AcpRegistryFeaturedLaunch;
  readonly npx?: { readonly package: string; readonly args: ReadonlyArray<string> };
  readonly uvx?: { readonly package: string; readonly args: ReadonlyArray<string> };
}

/**
 * Curated one-click ACP agents. Keep this list small and obvious; the live
 * registry RPC is how we pick up the long tail without a code change.
 */
export const ACP_FEATURED_AGENTS: ReadonlyArray<AcpRegistryFeaturedAgent> = [
  {
    id: "gemini",
    label: "Gemini",
    description: "Google's official Gemini CLI.",
    docsUrl: "https://geminicli.com",
    installHint: "npm i -g @google/gemini-cli && gemini",
    iconKey: "gemini",
    local: { command: "gemini", args: ["--acp"] },
    npx: { package: "@google/gemini-cli", args: ["--acp"] },
  },
  {
    id: "github-copilot-cli",
    label: "GitHub Copilot",
    description: "GitHub Copilot CLI over ACP.",
    docsUrl: "https://github.com/features/copilot/cli/",
    installHint: "npm i -g @github/copilot && copilot login",
    iconKey: "githubCopilot",
    local: { command: "copilot", args: ["--acp"] },
    npx: { package: "@github/copilot", args: ["--acp"] },
  },
  {
    id: "pi-acp",
    label: "Pi Agent",
    description: "Pi coding agent through its ACP adapter.",
    docsUrl: "https://pi.dev",
    installHint: "npm i -g @mariozechner/pi-coding-agent && npm i -g pi-acp",
    iconKey: "piAgent",
    local: { command: "pi-acp", args: [] },
    npx: { package: "pi-acp", args: [] },
  },
  {
    id: "hermes",
    label: "Hermes",
    description: "Nous Research Hermes agent over ACP.",
    docsUrl: "https://hermes-agent.nousresearch.com",
    installHint: "Install Hermes, then launch with `hermes acp`.",
    iconKey: "acpRegistry",
    local: { command: "hermes", args: ["acp"] },
  },
  {
    id: "qwen-code",
    label: "Qwen Code",
    description: "Alibaba's Qwen coding assistant.",
    docsUrl: "https://qwenlm.github.io/qwen-code-docs/en/users/overview",
    installHint: "npm i -g @qwen-code/qwen-code",
    iconKey: "acpRegistry",
    local: { command: "qwen", args: ["--acp", "--experimental-skills"] },
    npx: { package: "@qwen-code/qwen-code", args: ["--acp", "--experimental-skills"] },
  },
  {
    id: "kimi",
    label: "Kimi CLI",
    description: "Moonshot AI's Kimi coding assistant.",
    docsUrl: "https://moonshotai.github.io/kimi-cli/",
    installHint: "Install Kimi CLI, then launch with `kimi acp`.",
    iconKey: "acpRegistry",
    local: { command: "kimi", args: ["acp"] },
  },
  {
    id: "custom",
    label: "Custom ACP",
    description: "Any agent that speaks ACP over stdio.",
    installHint: "Point command and arguments at an ACP stdio binary.",
    iconKey: "acpRegistry",
  },
];

export const AcpRegistryIndexAgent = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  version: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(TrimmedNonEmptyString),
  repository: Schema.optional(TrimmedNonEmptyString),
  website: Schema.optional(TrimmedNonEmptyString),
  icon: Schema.optional(TrimmedNonEmptyString),
  distribution: Schema.Struct({
    npx: Schema.optional(
      Schema.Struct({
        package: TrimmedNonEmptyString,
        args: Schema.optional(Schema.Array(Schema.String)),
      }),
    ),
    uvx: Schema.optional(
      Schema.Struct({
        package: TrimmedNonEmptyString,
        args: Schema.optional(Schema.Array(Schema.String)),
      }),
    ),
    binary: Schema.optional(Schema.Unknown),
  }),
});
export type AcpRegistryIndexAgent = typeof AcpRegistryIndexAgent.Type;

export const AcpRegistryIndex = Schema.Struct({
  version: TrimmedNonEmptyString,
  agents: Schema.Array(AcpRegistryIndexAgent),
});
export type AcpRegistryIndex = typeof AcpRegistryIndex.Type;

export const AcpRegistryCatalogEntry = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  featured: Schema.Boolean,
  docsUrl: Schema.optional(TrimmedNonEmptyString),
  installHint: TrimmedNonEmptyString,
  iconKey: AcpRegistryCatalogIconKey,
  iconUrl: Schema.optional(TrimmedNonEmptyString),
  version: Schema.optional(TrimmedNonEmptyString),
  distributionType: AcpRegistryDistributionType,
  launch: Schema.NullOr(AcpRegistryLaunchSpec),
});
export type AcpRegistryCatalogEntry = typeof AcpRegistryCatalogEntry.Type;

export const AcpRegistryListResult = Schema.Struct({
  registryVersion: Schema.optional(TrimmedNonEmptyString),
  agents: Schema.Array(AcpRegistryCatalogEntry),
});
export type AcpRegistryListResult = typeof AcpRegistryListResult.Type;

export function featuredAgentById(
  catalogId: string | null | undefined,
): AcpRegistryFeaturedAgent | undefined {
  const id = catalogId?.trim();
  if (!id) return undefined;
  return ACP_FEATURED_AGENTS.find((agent) => agent.id === id);
}

export function defaultLaunchForFeaturedAgent(
  agent: AcpRegistryFeaturedAgent,
): AcpRegistryFeaturedLaunch | undefined {
  if (agent.local) return agent.local;
  if (agent.npx) {
    return {
      command: "npx",
      args: ["-y", agent.npx.package, ...agent.npx.args],
    };
  }
  if (agent.uvx) {
    return {
      command: "uvx",
      args: [agent.uvx.package, ...agent.uvx.args],
    };
  }
  return undefined;
}

/**
 * Split a launch-args string the way Codex/Claude settings do: whitespace
 * separated, with simple single/double quotes.
 */
export function parseAcpLaunchArgs(value: string | null | undefined): ReadonlyArray<string> {
  const input = value?.trim() ?? "";
  if (input.length === 0) return [];

  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (quote) {
      if (char === quote) {
        quote = undefined;
        continue;
      }
      current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) args.push(current);
  return args;
}

export function formatAcpLaunchArgs(args: ReadonlyArray<string>): string {
  return args.map((arg) => (/\s/u.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg)).join(" ");
}
