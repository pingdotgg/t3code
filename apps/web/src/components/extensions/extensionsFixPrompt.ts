// Fork: Kaluwa's Extensions page. The prompt "Fix with AI" hands a new thread. It is read by a
// model, so it stays English.
import type {
  ExtensionHealth,
  ExtensionKind,
  ExtensionMcpTransport,
  ExtensionSkill,
  ExtensionsSubscription,
} from "@t3tools/contracts";

import type { ExtensionEntry } from "./extensionsModel";

export const CLAUDE_CONNECTORS_URL = "https://claude.ai/settings/connectors";

type FixSubscription = Pick<ExtensionsSubscription, "displayName" | "driver" | "configHome">;

export type ExtensionFixProblem =
  | {
      readonly type: "extension";
      readonly kind: ExtensionKind;
      readonly name: string;
      /** The plugin's `name@marketplace`; the name otherwise. */
      readonly id: string;
      readonly health: ExtensionHealth;
      readonly detail: string | null;
      readonly transport: ExtensionMcpTransport | null;
      readonly target: string | null;
      readonly managedElsewhere: boolean;
      readonly path: string | null;
    }
  | {
      readonly type: "brokenLinks";
      readonly links: readonly Pick<ExtensionSkill, "name" | "path">[];
    };

export interface ExtensionFix {
  readonly prompt: string;
  /** The first thing to try by hand, for when no thread can be started. */
  readonly manual: string;
}

export function entryFixProblem(
  entry: ExtensionEntry,
  subscription: Pick<ExtensionsSubscription, "instanceId">,
): ExtensionFixProblem | null {
  const presence = entry.presence.get(subscription.instanceId);
  if (presence === undefined) return null;
  return {
    type: "extension",
    kind: entry.kind,
    name: entry.name,
    id: entry.id,
    health: presence.enabled ? presence.health : "disabled",
    detail: presence.detail,
    transport: entry.transport,
    target: entry.kind === "mcp" ? presence.location : null,
    managedElsewhere: presence.managedElsewhere,
    path: entry.kind === "skill" ? presence.location : null,
  };
}

/** How to point the provider's CLI at this subscription's config home. */
function cliPrefix(subscription: FixSubscription) {
  if (subscription.driver === "claudeAgent") {
    return { env: `CLAUDE_CONFIG_DIR=${subscription.configHome}`, cli: "claude" };
  }
  if (subscription.driver === "codex") {
    return { env: `CODEX_HOME=${subscription.configHome}`, cli: "codex" };
  }
  return null;
}

function numbered(steps: readonly string[]) {
  return steps.map((step, index) => `${index + 1}. ${step}`).join("\n");
}

const KIND_NAME: Record<ExtensionKind, string> = {
  mcp: "MCP server",
  plugin: "plugin",
  skill: "skill",
};

function header(subscription: FixSubscription, what: string) {
  return [
    `Help me fix ${what} in my "${subscription.displayName}" subscription (${subscription.driver}).`,
    `Its config home is ${subscription.configHome}. Every command must target that config home, not the default one.`,
  ];
}

function extensionSteps(
  problem: Extract<ExtensionFixProblem, { type: "extension" }>,
  subscription: FixSubscription,
): { readonly steps: readonly string[]; readonly manual: string } {
  const prefix = cliPrefix(subscription);
  const run = (args: string) => (prefix ? `\`${prefix.env} ${prefix.cli} ${args}\`` : null);

  if (problem.kind === "mcp") {
    const verify =
      run(`mcp get ${JSON.stringify(problem.name)}`) ??
      "the provider's own command for listing MCP servers";
    if (problem.managedElsewhere) {
      const manual = `Reconnect it at ${CLAUDE_CONNECTORS_URL}.`;
      return {
        manual,
        steps: [
          `This is an account-level claude.ai connector, not a server in a local config file, so no local command can sign it in. Tell me to open ${CLAUDE_CONNECTORS_URL}, find "${problem.name.replace(/^claude\.ai\s+/, "")}", and reconnect it (disconnect first if it shows as connected).`,
          `Wait for me to say I have done it. Do not edit any config file for this.`,
          `Then check it with ${verify} and tell me whether it now connects.`,
        ],
      };
    }
    if (problem.health === "needsAuth") {
      const login = run(`mcp login ${JSON.stringify(problem.name)}`);
      const manual = login
        ? `Run ${login} and finish the sign-in in the browser.`
        : `Sign in to "${problem.name}" with the provider's own MCP login command.`;
      return {
        manual,
        steps: [
          login
            ? `Run ${login}. It opens a browser window; tell me to finish the sign-in there and wait for the command to return.`
            : `Find this provider's command for signing in to an MCP server and run it for "${problem.name}" against the config home above.`,
          subscription.driver === "claudeAgent"
            ? `If that command is not available in this version, tell me to open a Claude thread on this subscription, run /mcp, pick "${problem.name}" and authenticate there.`
            : `If the sign-in fails, show me the exact error instead of retrying blindly.`,
          `Verify with ${verify}: it should report the server as connected.`,
        ],
      };
    }
    if (problem.transport === "stdio") {
      const command = (problem.target ?? "").trim().split(/\s+/)[0] ?? "";
      const manual = `Check the command exists with \`which ${command}\`, then run \`${problem.target}\` once to see its error.`;
      return {
        manual,
        steps: [
          `Check the command exists: \`which ${command}\`. If it is missing, say what has to be installed and ask before installing anything.`,
          `Run the server once by hand to see why it fails: \`${problem.target}\`. It speaks MCP over stdio, so it may just wait for input; stop it after a few seconds and read what it printed to stderr.`,
          `Check the server's entry with ${verify}: look for a wrong path, a missing argument or an environment variable it needs. Never print the values of secrets.`,
          `Fix the cause. If it needs a secret I have to supply, tell me which variable and stop.`,
          `Verify with ${verify}: it should report the server as connected.`,
        ],
      };
    }
    const manual = `Check that ${problem.target} is reachable and that its credentials are still valid.`;
    return {
      manual,
      steps: [
        `Check the URL answers at all: \`curl -sS -o /dev/null -w "%{http_code}" ${problem.target}\`. A 401 or 403 means the credential was rejected, not that the server is down.`,
        `Look at the server's entry with ${verify}. Never print header or token values.`,
        `If the credential was rejected, tell me which header or token needs replacing and where to get a new one; I will supply it. If the URL is wrong, propose the right one.`,
        `Verify with ${verify}: it should report the server as connected.`,
      ],
    };
  }

  if (problem.kind === "plugin") {
    const list = run("plugin list") ?? "the provider's plugin list command";
    const manual = `Check the plugin with ${list}.`;
    return {
      manual,
      steps: [
        `List the plugins with ${list} and find "${problem.id}".`,
        problem.health === "needsAuth"
          ? `The plugin bundles an MCP server that needs a sign-in. Find that server's name (${run("mcp list") ?? "list the MCP servers"}) and sign in to it${prefix ? ` with \`${prefix.env} ${prefix.cli} mcp login <server>\`` : ""}; tell me to finish the sign-in in the browser.`
          : `Work out why it fails from the error above. Updating or reinstalling it is fine; ask before uninstalling it for good.`,
        `Verify with ${list}: the plugin should be listed without an error.`,
      ],
    };
  }

  const file = `${problem.path ?? `${subscription.configHome}/skills/${problem.name}`}/SKILL.md`;
  const manual = `Open ${file} and fix its front matter.`;
  return {
    manual,
    steps: [
      `Read ${file}.`,
      `A skill needs YAML front matter at the top with a \`name:\` and a \`description:\`. If the description is missing, write one line saying what the skill does and when to use it, taken from the skill's own content. Fix whatever else the error above names.`,
      `Change nothing but that file, and show me the front matter you ended up with.`,
      `Verify by reading the file again: the front matter parses and has both fields.`,
    ],
  };
}

/** The step-by-step request a new thread starts with. */
export function buildExtensionFixPrompt(
  problem: ExtensionFixProblem,
  subscription: FixSubscription,
): ExtensionFix {
  if (problem.type === "brokenLinks") {
    const count = problem.links.length;
    const folder = problem.links[0]?.path.replace(/\/[^/]+\/?$/, "") ?? subscription.configHome;
    return {
      manual: `Delete the dead links in ${folder} (\`find ${folder} -maxdepth 1 -type l ! -exec test -e {} \\; -print\` lists them).`,
      prompt: [
        ...header(
          subscription,
          `${count} broken skill ${count === 1 ? "link" : "links"} (symlinks whose target no longer exists)`,
        ),
        "",
        "The broken links:",
        ...problem.links.map((link) => `- ${link.name}: ${link.path}`),
        "",
        "Steps:",
        numbered([
          `List what each link points at: \`ls -l ${folder}\`. Confirm for each one that the target really is gone.`,
          `Remove only the dead links (\`rm <link>\`). They are symlinks, so nothing behind them is deleted. Leave every link whose target exists, and every real folder, alone.`,
          `If a target looks like it was only moved or renamed, tell me before removing that link.`,
          `Verify: \`find ${folder} -maxdepth 1 -type l ! -exec test -e {} \\; -print\` prints nothing.`,
        ]),
      ].join("\n"),
    };
  }

  const state =
    problem.health === "needsAuth"
      ? "needs a sign-in"
      : `is ${problem.health === "failing" ? "failing" : problem.health}`;
  const { steps, manual } = extensionSteps(problem, subscription);
  return {
    manual,
    prompt: [
      ...header(subscription, `the ${KIND_NAME[problem.kind]} "${problem.name}", which ${state},`),
      ...(problem.target ? [`It is set up as (${problem.transport}): ${problem.target}`] : []),
      problem.detail
        ? `The exact error: ${problem.detail}`
        : "There is no error text beyond that status.",
      "",
      "Steps:",
      numbered(steps),
      "",
      "Tell me what you found and what you changed. Do not touch my other subscriptions.",
    ].join("\n"),
  };
}
