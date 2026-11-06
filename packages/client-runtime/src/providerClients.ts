import {
  AntigravitySettings,
  AwsBedrockSettings,
  ClaudeSettings,
  CloudflareSettings,
  CodexSettings,
  isProviderDriverKind,
  OllamaSettings,
  ProviderDriverKind,
  ZedSettings,
} from "@t3tools/contracts";
import { acpRegistryClient } from "@t3tools/provider-acp-registry/client";
import { defineProviderClient, makeProviderClientRegistry } from "@t3tools/provider-core/client";
import { modelShortName } from "@t3tools/provider-core/modelShortName";
import { cursorClient } from "@t3tools/provider-cursor/client";
import { fxClient } from "@t3tools/provider-fx/client";
import { grokClient } from "@t3tools/provider-grok/client";
import { kiroClient } from "@t3tools/provider-kiro/client";
import { museClient } from "@t3tools/provider-muse/client";
import { openCodeClient } from "@t3tools/provider-opencode/client";
import { piClient } from "@t3tools/provider-pi/client";

export const ollamaClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("ollama"),
  label: "Ollama",
  featured: true,
  modelFamilies: ["llama", "mistral", "qwen", "gemma", "deepseek", "phi"],
  settingsSchema: OllamaSettings,
  environmentFields: [
    {
      name: "OLLAMA_HOST",
      label: "Ollama host",
      description: "Host URL for Ollama API server (default: http://localhost:11434).",
      placeholder: "http://localhost:11434",
    },
  ],
  icon: {
    viewBox: "0 0 32 32",
    fill: { light: "#111827", dark: "#F9FAFB" },
    paths: [
      {
        d: "M10 4C8.9 4 8 4.9 8 6V14C8 15.1 8.9 16 10 16H11V22C11 23.1 11.9 24 13 24H15V28H18V24H21V28H24V20C24 17.8 22.2 16 20 16H18V12C18 7.6 14.4 4 10 4ZM11 7C11.6 7 12 7.4 12 8C12 8.6 11.6 9 11 9C10.4 9 10 8.6 10 8C10 7.4 10.4 7 11 7Z",
      },
    ],
  },
});

export const zedClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("zed"),
  label: "Zed",
  featured: true,
  settingsSchema: ZedSettings,
  icon: {
    viewBox: "0 0 24 24",
    fill: { light: "#0842A0", dark: "#4E8BF5" },
    paths: [
      {
        d: "M3 4.5C3 3.67 3.67 3 4.5 3H19.5C20.33 3 21 3.67 21 4.5V7C21 7.83 20.33 8.5 19.5 8.5H10.5L18.5 16.5H19.5C20.33 16.5 21 17.17 21 18V20.5C21 21.33 20.33 22 19.5 22H4.5C3.67 22 3 21.33 3 20.5V18C3 17.17 3.67 16.5 4.5 16.5H13.5L5.5 8.5H4.5C3.67 8.5 3 7.83 3 7V4.5Z",
      },
    ],
  },
});

export const cloudflareClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("cloudflare"),
  label: "Cloudflare",
  featured: true,
  modelFamilies: ["@cf/"],
  settingsSchema: CloudflareSettings,
  environmentFields: [
    {
      name: "CLOUDFLARE_API_TOKEN",
      label: "Cloudflare API token",
      description: "API token with Workers AI permissions.",
      placeholder: "Paste API token",
      sensitive: true,
    },
    {
      name: "CLOUDFLARE_ACCOUNT_ID",
      label: "Account ID",
      description: "Cloudflare account identifier.",
      placeholder: "Paste account ID",
    },
  ],
  icon: {
    viewBox: "0 0 24 24",
    fill: { light: "#F38020", dark: "#FAAD3F" },
    paths: [
      {
        d: "M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM19 18H6c-2.21 0-4-1.79-4-4 0-2.05 1.53-3.76 3.56-3.97l1.07-.11.5-.95C8.08 7.14 9.94 6 12 6c2.62 0 4.88 1.86 5.39 4.43l.3 1.5 1.53.11c1.56.1 2.78 1.41 2.78 2.96 0 1.65-1.35 3-3 3z",
      },
    ],
  },
});

export const bedrockClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("bedrock"),
  label: "AWS Bedrock",
  featured: true,
  modelFamilies: ["anthropic.", "amazon.", "meta."],
  settingsSchema: AwsBedrockSettings,
  environmentFields: [
    {
      name: "AWS_ACCESS_KEY_ID",
      label: "Access key ID",
      description: "AWS access key with Bedrock invoke permissions.",
      placeholder: "AKIA...",
      sensitive: true,
    },
    {
      name: "AWS_SECRET_ACCESS_KEY",
      label: "Secret access key",
      description: "AWS secret access key.",
      placeholder: "Paste secret access key",
      sensitive: true,
    },
    {
      name: "AWS_REGION",
      label: "AWS Region",
      description: "AWS region (default: us-east-1).",
      placeholder: "us-east-1",
    },
  ],
  icon: {
    viewBox: "0 0 24 24",
    fill: { light: "#FF9900", dark: "#FF9900" },
    paths: [
      {
        d: "M12 2L2 7V17L12 22L22 17V7L12 2ZM12 4.18L19.5 8.36L12 12.55L4.5 8.36L12 4.18ZM4 9.82L11 13.71V20.18L4 16.29V9.82ZM13 20.18V13.71L20 9.82V16.29L13 20.18Z",
      },
    ],
  },
});

export const providerClients = makeProviderClientRegistry([
  {
    driverKind: ProviderDriverKind.make("codex"),
    label: "Codex",
    modelFamilies: ["GPT-", "GPT "],
    acpRegistryAgentIds: ["codex-acp"],
    settingsSchema: CodexSettings,
  },
  {
    driverKind: ProviderDriverKind.make("claudeAgent"),
    label: "Claude",
    modelFamilies: ["Claude "],
    acpRegistryAgentIds: ["claude-acp"],
    settingsSchema: ClaudeSettings,
  },
  cursorClient,
  grokClient,
  fxClient,
  openCodeClient,
  {
    driverKind: ProviderDriverKind.make("antigravity"),
    label: "Antigravity",
    modelFamilies: ["Gemini "],
    acpRegistryAgentIds: ["antigravity-acp"],
    settingsSchema: AntigravitySettings,
  },
  kiroClient,
  museClient,
  piClient,
  ollamaClient,
  zedClient,
  cloudflareClient,
  bedrockClient,
  acpRegistryClient,
]);

export function getProviderClient(driver: string | null | undefined) {
  return isProviderDriverKind(driver) ? providerClients.get(driver) : undefined;
}

export function resolveModelShortName(
  model: { readonly name: string; readonly shortName?: string | undefined },
  driverKind: ProviderDriverKind | null | undefined,
): string | undefined {
  if (model.shortName) return model.shortName;
  const families = driverKind ? providerClients.get(driverKind)?.modelFamilies : undefined;
  return modelShortName(model.name, families ?? []);
}
