import type { TipId } from "@t3tools/contracts";

import type { SettingsPath, SettingsSearchItemId } from "../components/settings/settingsSearch";

const DOCS = "https://github.com/pingdotgg/t3code/blob/main/docs/user";

export type TipAction =
  | { readonly kind: "boring-sidebar"; readonly label: string }
  | {
      readonly kind: "setting";
      readonly label: string;
      readonly to: SettingsPath;
      readonly target: SettingsSearchItemId;
      /** The setting is per machine, so it opens scoped to the draft's machine. */
      readonly scoped?: boolean;
    }
  | {
      readonly kind: "prompt";
      readonly label: string;
      readonly prompt: string;
      /** Fills the composer only when it uses this provider; otherwise it copies. */
      readonly driver?: string;
    }
  | { readonly kind: "copy"; readonly label: string; readonly text: string }
  | { readonly kind: "link"; readonly label: string; readonly href: string };

export interface Tip {
  readonly id: TipId;
  /** Whole days after the tips clock starts before the tip can join the strip. */
  readonly minAgeDays: number;
  readonly lead: string;
  readonly body: string;
  readonly actions: ReadonlyArray<TipAction>;
}

/** Introduction order. `docs/user/tips.md` lists the same tips in the same order. */
export const TIPS = [
  {
    id: "boring-sidebar",
    minAgeDays: 0,
    lead: "Prefer threads grouped by project?",
    body: "Turn on the Boring sidebar in Labs. You can switch back at any time.",
    actions: [
      { kind: "boring-sidebar", label: "Turn it on" },
      { kind: "setting", label: "Settings", to: "/settings/labs", target: "boring-sidebar" },
    ],
  },
  {
    id: "voice-input",
    minAgeDays: 0,
    lead: "Dictate with a local model.",
    body: "Voice input can transcribe on a computer you choose, instead of a cloud service.",
    actions: [
      {
        kind: "setting",
        label: "Set up voice",
        to: "/settings/voice",
        target: "voice-transcription-destination",
      },
    ],
  },
  {
    id: "claude-codex",
    minAgeDays: 1,
    lead: "Claude can start Codex threads.",
    body: "Ask Claude to delegate a task to Codex. The subagent reports back when it finishes.",
    actions: [
      {
        kind: "prompt",
        label: "Try it",
        prompt:
          "Start a Codex subagent to review this project for bugs and missing tests. Tell me what it finds.",
        driver: "claudeAgent",
      },
    ],
  },
  {
    id: "phone-app",
    minAgeDays: 2,
    lead: "Use T3 Code from your phone.",
    body: "Get the iOS or Android app and connect it to the computer that runs your threads.",
    actions: [
      { kind: "setting", label: "Get the app", to: "/settings/about", target: "mobile-app" },
    ],
  },
  {
    id: "agent-threads",
    minAgeDays: 3,
    lead: "Threads can start other threads.",
    body: "Ask an agent to split the work. With linked environments, it can start threads on your other computers too.",
    actions: [
      {
        kind: "prompt",
        label: "Try it",
        prompt:
          "Start two new threads in this project: one to find slow tests and one to find unused exports. Send me links to both.",
      },
    ],
  },
  {
    id: "side-chats",
    minAgeDays: 4,
    lead: "Ask a side question with /btw.",
    body: "After your first message, send one that starts with /btw. The answer opens in a side chat, and the thread keeps working.",
    actions: [{ kind: "link", label: "Learn more", href: `${DOCS}/thread-sidebar.md#side-chats` }],
  },
  {
    id: "other-computers",
    minAgeDays: 6,
    lead: "Control your other computers from here.",
    body: "Install T3 Code there, or run npx t3@latest up. Then connect with T3 Connect or Tailscale.",
    actions: [
      { kind: "copy", label: "Copy command", text: "npx t3@latest up" },
      { kind: "link", label: "How to connect", href: `${DOCS}/remote-access.md` },
    ],
  },
  {
    id: "mcp-apps",
    minAgeDays: 9,
    lead: "Use T3 Code from Poke, Grok Bot, and other apps.",
    body: "Apps that support MCP, like ChatGPT, can start threads and check on them for you.",
    actions: [{ kind: "link", label: "Set it up", href: `${DOCS}/outside-agents.md` }],
  },
  {
    id: "devices",
    minAgeDays: 12,
    lead: "Agents can drive simulators and emulators.",
    body: "They can run your mobile app on an iOS Simulator or Android Emulator, even on a remote Mac.",
    actions: [
      {
        kind: "setting",
        label: "Devices",
        to: "/settings/devices",
        target: "device-hub",
        scoped: true,
      },
      { kind: "link", label: "Learn more", href: `${DOCS}/devices.md#ssh-device-hosts` },
    ],
  },
] as const satisfies ReadonlyArray<Tip>;

export const TIPS_DOCS_URL = `${DOCS}/tips.md`;

export const TIP_BY_ID: ReadonlyMap<TipId, Tip> = new Map(TIPS.map((tip) => [tip.id, tip]));
