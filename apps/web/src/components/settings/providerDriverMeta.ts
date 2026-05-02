import {
  ClaudeSettings,
  CodexSettings,
  CursorSettings,
  OpenCodeSettings,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { ClaudeAI, CursorIcon, type Icon, OpenAI, OpenCodeIcon } from "../Icons";

type ProviderSettingsSchema = {
  readonly fields: Readonly<Record<string, unknown>>;
};

export type ProviderSettingsControl = "text" | "password" | "textarea" | "switch";

export interface ProviderSettingsFieldUi {
  readonly control?: ProviderSettingsControl;
  readonly label?: string;
  readonly placeholder?: string;
  readonly description?: string;
  readonly hidden?: boolean;
  readonly clearWhenEmpty?: "omit" | "persist";
}

export interface ProviderSettingsUi {
  readonly order?: readonly string[];
  readonly fields?: Readonly<Record<string, ProviderSettingsFieldUi>>;
}

/**
 * Browser-safe provider definition. This is deliberately shaped like the
 * future provider package client export: the core web app gets a schema,
 * presentation metadata, and a small UI hint layer, then renders generically.
 */
export interface ProviderClientDefinition {
  readonly value: ProviderDriverKind;
  readonly label: string;
  readonly icon: Icon;
  readonly settingsSchema: ProviderSettingsSchema;
  readonly settingsUi: ProviderSettingsUi;
  /**
   * Optional short label rendered as a `variant="warning"` badge next to
   * the instance title. Used to flag drivers that still ship under an
   * early-access or preview gate — the flag is a property of the driver
   * kind (not a specific instance), so every instance of that driver —
   * built-in default or custom — advertises the same marker.
   */
  readonly badgeLabel?: string;
}

export const PROVIDER_CLIENT_DEFINITIONS: readonly ProviderClientDefinition[] = [
  {
    value: ProviderDriverKind.make("codex"),
    label: "Codex",
    icon: OpenAI,
    settingsSchema: CodexSettings,
    settingsUi: {
      order: ["binaryPath", "homePath", "shadowHomePath"],
      fields: {
        enabled: { hidden: true },
        customModels: { hidden: true },
        binaryPath: {
          label: "Binary path",
          placeholder: "codex",
          description: "Path to the Codex binary used by this instance.",
          clearWhenEmpty: "omit",
        },
        homePath: {
          label: "CODEX_HOME path",
          placeholder: "~/.codex",
          description: "Custom Codex home and config directory.",
          clearWhenEmpty: "omit",
        },
        shadowHomePath: {
          label: "Shadow home path",
          placeholder: "~/.codex-t3/personal",
          description:
            "Account-specific Codex home. Keeps auth.json separate while sharing state from CODEX_HOME.",
          clearWhenEmpty: "omit",
        },
      },
    },
  },
  {
    value: ProviderDriverKind.make("claudeAgent"),
    label: "Claude",
    icon: ClaudeAI,
    settingsSchema: ClaudeSettings,
    settingsUi: {
      order: ["binaryPath", "homePath", "launchArgs"],
      fields: {
        enabled: { hidden: true },
        customModels: { hidden: true },
        binaryPath: {
          label: "Binary path",
          placeholder: "claude",
          description: "Path to the Claude binary used by this instance.",
          clearWhenEmpty: "omit",
        },
        homePath: {
          label: "Claude HOME path",
          placeholder: "~",
          description:
            "Custom HOME used when running this Claude instance. Keeps .claude.json and .claude separate.",
          clearWhenEmpty: "omit",
        },
        launchArgs: {
          label: "Launch arguments",
          placeholder: "e.g. --chrome",
          description: "Additional CLI arguments passed on session start.",
          clearWhenEmpty: "omit",
        },
      },
    },
  },
  {
    value: ProviderDriverKind.make("cursor"),
    label: "Cursor",
    icon: CursorIcon,
    badgeLabel: "Early Access",
    settingsSchema: CursorSettings,
    settingsUi: {
      order: ["binaryPath", "apiEndpoint"],
      fields: {
        enabled: { hidden: true },
        customModels: { hidden: true },
        binaryPath: {
          label: "Binary path",
          placeholder: "agent",
          description: "Path to the Cursor agent binary.",
          clearWhenEmpty: "omit",
        },
        apiEndpoint: {
          label: "API endpoint",
          placeholder: "https://...",
          description: "Override the Cursor API endpoint for this instance.",
          clearWhenEmpty: "omit",
        },
      },
    },
  },
  {
    value: ProviderDriverKind.make("opencode"),
    label: "OpenCode",
    icon: OpenCodeIcon,
    settingsSchema: OpenCodeSettings,
    settingsUi: {
      order: ["binaryPath", "serverUrl", "serverPassword"],
      fields: {
        enabled: { hidden: true },
        customModels: { hidden: true },
        binaryPath: {
          label: "Binary path",
          placeholder: "opencode",
          description: "Path to the OpenCode binary.",
          clearWhenEmpty: "omit",
        },
        serverUrl: {
          label: "Server URL",
          placeholder: "http://127.0.0.1:4096",
          description: "Leave blank to let T3 Code spawn the server when needed.",
          clearWhenEmpty: "omit",
        },
        serverPassword: {
          control: "password",
          label: "Server password",
          placeholder: "Optional",
          description: "Stored in plain text on disk.",
          clearWhenEmpty: "omit",
        },
      },
    },
  },
];

export const PROVIDER_CLIENT_DEFINITION_BY_VALUE: Partial<
  Record<ProviderDriverKind, ProviderClientDefinition>
> = Object.fromEntries(
  PROVIDER_CLIENT_DEFINITIONS.map((definition) => [definition.value, definition]),
);

export const DRIVER_OPTIONS = PROVIDER_CLIENT_DEFINITIONS;
export const DRIVER_OPTION_BY_VALUE = PROVIDER_CLIENT_DEFINITION_BY_VALUE;
export type DriverOption = ProviderClientDefinition;

/**
 * Look up the driver metadata for an instance's `driver` field. Accepts
 * Returns `undefined` for fork / unknown drivers so callers can decide how
 * to render them — typically by falling back to a generic card.
 */
export function getDriverOption(driver: ProviderDriverKind | undefined): DriverOption | undefined {
  if (driver === undefined) return undefined;
  return PROVIDER_CLIENT_DEFINITION_BY_VALUE[driver];
}
