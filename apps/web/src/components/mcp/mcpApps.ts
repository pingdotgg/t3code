import hermesLogo from "./logos/hermes.png";
import openClawLogo from "./logos/openclaw.png";

/**
 * Apps that run on the user's own devices. T3 Code's MCP address is on the tailnet, so hosted
 * apps (Claude.ai, ChatGPT, Poke, ...) cannot reach it and are not offered.
 */
export interface McpApp {
  readonly id: string;
  readonly name: string;
  readonly logo: string;
  /** Commands to run where the app runs. */
  readonly commands: (mcpUrl: string) => readonly string[];
  /** "Set up another way", next to the URL. */
  readonly steps: readonly string[];
  /** One line under the commands. */
  readonly note?: string;
  readonly docs?: string;
}

export const MCP_APPS: readonly McpApp[] = [
  {
    id: "openclaw",
    name: "OpenClaw",
    logo: openClawLogo,
    commands: (url) => [
      // Its MCP commands refuse to write while the Gateway runs.
      "openclaw gateway stop",
      `openclaw mcp add t3code --url ${url} --transport streamable-http --auth oauth`,
      "openclaw mcp login t3code",
      "openclaw gateway start",
    ],
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
    commands: (url) => [
      // `add` signs in on its first connection (30 s by default, too short to get a code);
      // `login` would clear that sign-in and need a second code.
      `hermes mcp add t3code --url ${url} --auth oauth --connect-timeout 315`,
    ],
    steps: [
      "Add t3code under mcp_servers in ~/.hermes/config.yaml, with the URL and auth: oauth.",
      "Run hermes mcp login t3code.",
    ],
    note: "On a remote host, paste the final URL back when asked.",
    docs: "https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp",
  },
];

/** The "Something else…" choice: the URL and general steps only. */
export const OTHER_MCP_APP_STEPS = [
  "On a device in your tailnet, add a remote MCP server with OAuth.",
] as const;
