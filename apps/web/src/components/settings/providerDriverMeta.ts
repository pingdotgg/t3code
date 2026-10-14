import {
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  KiroSettings,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { acpRegistryClient } from "@t3tools/provider-acp-registry/client";
import { makeProviderClientRegistry } from "@t3tools/provider-core/client";
import { cursorClient } from "@t3tools/provider-cursor/client";
import { grokClient } from "@t3tools/provider-grok/client";
import { museClient } from "@t3tools/provider-muse/client";
import { openCodeClient } from "@t3tools/provider-opencode/client";
import { piClient } from "@t3tools/provider-pi/client";

/** The provider client definitions this web build ships, in presentation order. */
export const providerClients = makeProviderClientRegistry([
  {
    driverKind: ProviderDriverKind.make("codex"),
    label: "Codex",
    settingsSchema: CodexSettings,
  },
  {
    driverKind: ProviderDriverKind.make("claudeAgent"),
    label: "Claude",
    settingsSchema: ClaudeSettings,
  },
  cursorClient,
  grokClient,
  openCodeClient,
  {
    driverKind: ProviderDriverKind.make("antigravity"),
    label: "Antigravity",
    settingsSchema: AntigravitySettings,
  },
  {
    driverKind: ProviderDriverKind.make("kiro"),
    label: "Kiro",
    badgeLabel: "Early Access",
    settingsSchema: KiroSettings,
    environmentFields: [
      {
        name: "KIRO_API_KEY",
        label: "Kiro API key",
        description: "Optional. Signs in without `kiro-cli login` (Kiro Pro and above).",
        placeholder: "Paste API key",
        sensitive: true,
      },
    ],
  },
  museClient,
  piClient,
  acpRegistryClient,
]);
