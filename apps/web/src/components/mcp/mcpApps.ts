import chatgptLogo from "./logos/chatgpt.png";
import claudeLogo from "./logos/claude.png";
import geminiLogo from "./logos/gemini.png";
import grokBotLogo from "./logos/grokbot.png";
import hermesLogo from "./logos/hermes.png";
import instinctLogo from "./logos/instinct.png";
import museLogo from "./logos/muse.png";
import openClawLogo from "./logos/openclaw.png";
import pokeLogo from "./logos/poke.png";

/** How the Connect step hands T3 Code's MCP URL to an app. Every link is https. */
export type McpAppHandoff =
  /** Opens the app's add form with T3 Code filled in. */
  | { readonly kind: "open"; readonly link: (mcpUrl: string) => string }
  /** Copies the URL, then opens the page it goes on. */
  | { readonly kind: "copy-url"; readonly link: string }
  /** Copies a message for the app's chat, then opens the app. */
  | {
      readonly kind: "copy-message";
      readonly link: string;
      readonly message: (mcpUrl: string) => string;
    }
  /** Commands to run where the app runs. */
  | { readonly kind: "commands"; readonly commands: (mcpUrl: string) => readonly string[] };

export interface McpApp {
  readonly id: string;
  readonly name: string;
  readonly logo: string;
  readonly handoff: McpAppHandoff;
  /** "Set up another way", next to the URL. */
  readonly steps: readonly string[];
  /** One line under the primary action. */
  readonly note?: string;
  readonly docs?: string;
  /** Kept out of the grid until its sign-in works. */
  readonly hidden?: boolean;
}

const encoded = encodeURIComponent;

export const MCP_APPS: readonly McpApp[] = [
  {
    id: "poke",
    name: "Poke",
    logo: pokeLogo,
    handoff: {
      kind: "open",
      link: (url) => `https://poke.com/integrations/new?name=T3%20Code&url=${encoded(url)}`,
    },
    steps: ["Open poke.com/integrations/new.", "Paste the URL and add the integration."],
    docs: "https://poke.com/docs/mcp-servers",
  },
  {
    id: "claude",
    name: "Claude",
    logo: claudeLogo,
    handoff: {
      kind: "open",
      link: (url) =>
        `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=T3%20Code&connectorUrl=${encoded(url)}`,
    },
    steps: [
      "In Claude, open Customize, then Connectors.",
      "Choose Add custom connector and paste the URL.",
      "The Free plan allows one custom connector.",
    ],
    docs: "https://claude.com/docs/connectors/building/directory-vs-custom",
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    logo: chatgptLogo,
    handoff: { kind: "copy-url", link: "https://chatgpt.com/plugins" },
    steps: [
      "Open chatgpt.com/plugins on the web, then + and Add custom MCP server.",
      "Paste the URL. Choose OAuth.",
      "Create it as a plugin, then install it.",
    ],
    docs: "https://developers.openai.com/api/docs/guides/custom-mcp-server",
  },
  {
    id: "grok-bot",
    name: "Grok Bot",
    logo: grokBotLogo,
    // The app has no web chat, and its prompt links need a Bot id.
    handoff: {
      kind: "copy-message",
      link: "https://x.ai/bot",
      message: (url) => `Add the MCP server ${url} and connect it.`,
    },
    steps: ["Send this message to any of your Grok Bots."],
    note: "Shared with all your Grok Bots.",
    docs: "https://docs.x.ai/grok-bot/computer-and-apps",
  },
  {
    id: "gemini",
    name: "Gemini",
    logo: geminiLogo,
    handoff: { kind: "copy-url", link: "https://gemini.google.com/apps" },
    steps: [
      "In Gemini, open Settings, then Connected apps.",
      "Choose Custom apps, then Add, and paste the URL.",
    ],
    docs: "https://support.google.com/gemini/answer/17209137",
    // Gemini's sign-in and its tool schema checks do not work with T3 Code yet.
    hidden: true,
  },
  {
    id: "muse",
    name: "Muse",
    logo: museLogo,
    handoff: {
      kind: "copy-message",
      link: "https://muse.ai",
      message: (url) => `Create a custom connector for the MCP server ${url}.`,
    },
    steps: ["Send this message to Muse."],
    docs: "https://www.meta.com/help/artificial-intelligence/1687253048996149/",
  },
  {
    id: "instinct",
    name: "Instinct",
    logo: instinctLogo,
    handoff: {
      kind: "copy-message",
      link: "https://app.instinct.com",
      message: (url) => `Connect the MCP server ${url}.`,
    },
    steps: ["In Instinct, open Settings, then MCP connections, if your account has it."],
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    logo: openClawLogo,
    handoff: {
      kind: "commands",
      commands: (url) => [
        `openclaw mcp add t3code --url ${url} --transport streamable-http --auth oauth`,
        "openclaw mcp login t3code",
      ],
    },
    steps: ["Open the Control UI, then + and Plugins.", "Choose Add MCP server and paste the URL."],
    docs: "https://docs.openclaw.ai/tools/mcp",
  },
  {
    id: "hermes-agent",
    name: "Hermes Agent",
    logo: hermesLogo,
    handoff: {
      kind: "commands",
      commands: (url) => [
        `hermes mcp add t3code --url ${url} --auth oauth`,
        "hermes mcp login t3code",
      ],
    },
    steps: ["Run the commands where Hermes Agent runs."],
    note: "On a remote host, paste the final URL back when asked.",
    docs: "https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp",
  },
];

/** The "Something else…" choice: the URL and general steps only. */
export const OTHER_MCP_APP_STEPS = ["Add a remote MCP server with OAuth."] as const;

/** The primary button's label for `app`; commands get a copy button each instead. */
export function mcpHandoffLabel(app: McpApp): string | null {
  switch (app.handoff.kind) {
    case "open":
      return `Open in ${app.name}`;
    case "copy-url":
      return `Copy URL and open ${app.name}`;
    case "copy-message":
      return `Copy message and open ${app.name}`;
    case "commands":
      return null;
  }
}

/** The page the primary action opens, if any. */
export function mcpHandoffLink(handoff: McpAppHandoff, mcpUrl: string): string | null {
  switch (handoff.kind) {
    case "open":
      return handoff.link(mcpUrl);
    case "copy-url":
    case "copy-message":
      return handoff.link;
    case "commands":
      return null;
  }
}
