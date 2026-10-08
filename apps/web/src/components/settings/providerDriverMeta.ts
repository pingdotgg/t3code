import {
  AcpRegistrySettings,
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  CursorSettings,
  GrokSettings,
  OpenCodeSettings,
  MuseSettings,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { makeProviderClientRegistry } from "@t3tools/provider-core/client";
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
  {
    driverKind: ProviderDriverKind.make("cursor"),
    label: "Cursor",
    settingsSchema: CursorSettings,
    environmentFields: [
      {
        name: "CURSOR_API_KEY",
        label: "Cursor API key",
        description: "Optional. Overrides browser sign-in for this provider.",
        placeholder: "Paste API key",
        sensitive: true,
      },
    ],
  },
  {
    driverKind: ProviderDriverKind.make("grok"),
    label: "Grok",
    settingsSchema: GrokSettings,
  },
  {
    driverKind: ProviderDriverKind.make("opencode"),
    label: "OpenCode",
    settingsSchema: OpenCodeSettings,
  },
  {
    driverKind: ProviderDriverKind.make("antigravity"),
    label: "Antigravity",
    settingsSchema: AntigravitySettings,
  },
  {
    driverKind: ProviderDriverKind.make("muse"),
    label: "Muse Code",
    settingsSchema: MuseSettings,
    badgeLabel: "Beta",
  },
  piClient,
  {
    driverKind: ProviderDriverKind.make("acpRegistry"),
    label: "ACP Registry",
    settingsSchema: AcpRegistrySettings,
    hasDefaultInstance: false,
  },
]);
