import chatgptLogo from "./logos/chatgpt.png";
import claudeLogo from "./logos/claude.png";
import geminiLogo from "./logos/gemini.png";
import grokBotLogo from "./logos/grokbot.png";
import hermesLogo from "./logos/hermes.png";
import instinctLogo from "./logos/instinct.png";
import museLogo from "./logos/muse.png";
import openClawLogo from "./logos/openclaw.png";
import pokeLogo from "./logos/poke.png";

/** How the Connect step hands T3 Code's MCP URL to an app. Every `link` is https. */
export type McpAppHandoff =
  /** Opens the app's add form with T3 Code filled in. */
  | { readonly kind: "open"; readonly link: (mcpUrl: string) => string }
  /** Copies the URL, then opens the page it goes on. */
  | { readonly kind: "copy-url"; readonly link: string }
  /** Copies a message for the app's chat, then opens the app. */
  | {
      readonly kind: "copy-message";
      readonly link: string;
      /**
       * Opens the installed app first, given the message; `link` is the fallback. The desktop
       * app opens only the link shapes `APP_LAUNCH_URLS` in ElectronShell lists.
       */
      readonly appLink?: (message: string) => string;
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
    // No web chat, and no link that prefills a message yet (Grok Bot plans one), so the app
    // opens bare and the copied message is pasted in.
    handoff: {
      kind: "copy-message",
      link: "https://x.ai/bot",
      appLink: () => "grokbot://app",
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
        // Its MCP commands refuse to write while the Gateway runs.
        "openclaw gateway stop",
        `openclaw mcp add t3code --url ${url} --transport streamable-http --auth oauth`,
        "openclaw mcp login t3code",
        "openclaw gateway start",
      ],
    },
    steps: [
      "Open the Control UI, then + and Plugins, and choose Add MCP server.",
      "Paste the URL, and choose Streamable HTTP and OAuth.",
      "Select Sign in for it under Settings → MCP.",
    ],
    docs: "https://docs.openclaw.ai/tools/mcp",
  },
  {
    id: "hermes-agent",
    name: "Hermes Agent",
    logo: hermesLogo,
    handoff: {
      kind: "commands",
      commands: (url) => [
        // `add` signs in on its first connection (30 s by default, too short to get a code);
        // `login` would clear that sign-in and need a second code.
        `hermes mcp add t3code --url ${url} --auth oauth --connect-timeout 315`,
      ],
    },
    steps: [
      "Add t3code under mcp_servers in ~/.hermes/config.yaml, with the URL and auth: oauth.",
      "Run hermes mcp login t3code.",
    ],
    note: "On a remote host, paste the final URL back when asked.",
    docs: "https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp",
  },
];

/** The "Something else…" choice: the URL and general steps only. */
export const OTHER_MCP_APP_STEPS = ["Add a remote MCP server with OAuth."] as const;

/**
 * The primary button for `app`: its label, the https page it opens, and what it copies first.
 * Null for apps set up with commands. It never copies the approval code.
 */
export function mcpHandoffAction(app: McpApp, mcpUrl: string) {
  const { handoff } = app;
  switch (handoff.kind) {
    case "open":
      return {
        label: `Open in ${app.name}`,
        link: handoff.link(mcpUrl),
        appLink: null,
        copy: null,
      };
    case "copy-url":
      return {
        label: `Copy URL and open ${app.name}`,
        link: handoff.link,
        appLink: null,
        copy: { text: mcpUrl, title: "URL copied" },
      };
    case "copy-message": {
      const message = handoff.message(mcpUrl);
      return {
        label: `Copy message and open ${app.name}`,
        link: handoff.link,
        appLink: handoff.appLink?.(message) ?? null,
        copy: { text: message, title: "Message copied" },
      };
    }
    case "commands":
      return null;
  }
}
