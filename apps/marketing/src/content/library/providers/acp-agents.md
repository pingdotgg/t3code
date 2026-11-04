---
title: "Connect any ACP agent"
description: "Add ACP agents to T3 Code from the Registry or a local command, complete agent-owned sign-in, and understand models, permissions, sessions, and limits."
updated: 2026-11-04
sources:
  - label: "ACP provider setup and behavior"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-acp.md"
  - label: "Provider setup"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md"
faq:
  - question: "Can T3 Code connect an agent outside its built-in providers?"
    answer: "Yes. T3 Code can add agents from the ACP Registry or launch an installed Local ACP command. The agent supplies its models, tools, and authentication."
  - question: "Where do ACP agents run in T3 Code?"
    answer: "ACP agents run on the machine hosting the selected T3 Code environment. This stays true when you connect through a browser, phone, T3 Connect, or a relay."
  - question: "Can I use an API key with a T3 Code ACP agent?"
    answer: "If the agent supports environment-based API keys, put the key in that instance's environment settings. Other T3 Code ACP agents advertise browser or terminal sign-in methods."
  - question: "Does an ACP agent support conversation rewind?"
    answer: "Generic ACP agents cannot rewind their own conversation. After a checkpoint rollback, T3 Code starts a fresh agent session on the next turn."
---

T3 Code connects coding agents through the Agent Client Protocol, using an ACP Registry entry or an installed local command. ACP is the protocol between the client and agent; the agent brings its own models, tools, and sign-in while T3 Code supplies projects, threads, checkpoints, and delegation.

## Choose the dedicated provider or generic ACP path

Use a dedicated provider when T3 Code already offers one. [Claude Code](/learn/providers/claude-code), [Codex](/learn/providers/codex), [Cursor](/learn/providers/cursor), [Grok](/learn/providers/grok), [OpenCode](/learn/providers/opencode), [Pi](/learn/providers/pi), and [Antigravity](/learn/providers/antigravity) do not appear in the Registry list.

The [Kiro](/learn/providers/kiro), [fx](/learn/providers/fx), and [Muse Code](/learn/providers/muse-code) guides also describe their own provider setup. Use the [coding agents comparison](/learn/providers) to find those instructions before creating a generic command configuration.

| Situation                                   | Connection path                  |
| ------------------------------------------- | -------------------------------- |
| T3 Code has a dedicated provider            | Enable that provider in settings |
| An agent is distributed by the ACP Registry | Add its Registry result          |
| An ACP executable is already installed      | Add a Local ACP command          |

T3 Code prefers the ACP v2 preview and negotiates v1 for Registry agents that have not migrated. Features depend on what the agent advertises. A protocol connection does not guarantee every agent supports identical sessions, controls, or delegation views.

## Add an agent from the ACP Registry

1. [Install T3 Code](/download), then open `Settings > Providers`.
2. Select the environment that will run the agent.
3. Choose `Add provider`, then `Show more`.
4. Search for the agent and select `Add` on its result.
5. Confirm its name and instance ID, then finish the offered sign-in.

Search lists agents that can run on the connected server. Registry agents are third-party code. Review the source and license before adding one.

Registry installations live under `tools/<agent-id>/<version>/` inside T3 home. T3 Code verifies SHA-256 when an entry supplies a checksum. Without one, distribution retains the Registry's HTTPS guarantee. Registry `npx` and `uvx` packages use T3-owned directories at the Registry's exact version.

## Connect an existing local ACP command

In `Settings > Providers > Add provider`, select `Show more`, then `Local ACP command`. Enter the executable name or path on the environment. Add one literal argument per row and choose a display name.

For DeepSeek Harness, the documented executable is `dsh` with argument rows `--profile` and `acp`. Local commands need no Registry download. T3 Code launches the executable directly without expanding shell expressions, so do not rely on shell substitution in argument fields.

Instance environment overrides apply to execution. Credentials and skills remain the responsibility of the installed agent or wrapper. For a managed Registry distribution, `Executable override` selects an existing executable while retaining Registry-declared arguments and environment.

## Complete the agent's own sign-in

Open the agent's account section in `Settings > Providers` on web or desktop. Select `Sign in` and choose a method if several are offered. Mobile also supports settings for installed, configured instances.

Browser methods show the agent's URL and wait for you to open or copy it before proceeding. The browser opens on your device; the agent remains on the environment. Terminal methods use an in-app terminal there, with a terminal response field on mobile. Wait for the agent to confirm sign-in rather than treating an opened browser as success.

Credentials stay in the agent's store. Agents using API-key environment variables take those keys in instance settings. The configured environment and home apply to both sign-in and chat.

ACP does not define account isolation. Adding an instance therefore does not guarantee a separate account. Changing a shared login stops running threads for that agent on the environment while retaining history and files. Use agent-owned configuration to isolate accounts when supported.

## Discover models, commands, and native sessions

Models and reasoning options come from the agent. Add exact IDs under `Custom models` if the agent reports none or omits one. Agent options appear beside models, and advertised plan/build modes follow T3 Code's toggle.

During a session, slash commands appear under Provider in the `/` menu. Commands named with `$` appear in the skill menu instead.

Agents advertising session listing and import support expose `List sessions` on their provider card after you choose a project. Importing the same native session again returns the existing T3 Code thread. This capability is conditional; do not assume every ACP agent exposes it.

## Understand agent permissions and rollback

Agents execute their own file operations and commands under their own sandbox and mode. Use the agent's mode picker and settings to control that boundary.

When an agent asks T3 Code for approval, Supervised displays the request. Auto-accept edits approves edits and displays other requests. Auto and Full access approve automatically. File reads and searches do not wait for approval. Read [permission modes](/learn/safety/permission-modes) alongside the agent's native controls.

Devin commands run through T3 Code terminals and follow thread permissions. For other agents, T3 Code displays reported terminal output and exit status but does not operate or stop their terminals. [Outside-agent access](/learn/safety/outside-agents) describes a separate route for driving T3 Code itself.

Checkpoint rollback restores files, but ACP agents cannot rewind their conversation. The next turn starts a fresh session without the earlier conversation. Registry instances also do not provide app-owned titles, branch names, commit messages, or PR descriptions. Configure a text-generation-capable provider for those actions.

## Next steps

- Read how to [add a provider integration](/learn/open-source/adding-a-provider) when contributing native support.
- Use [remote access](/learn/remote/remote-access) to connect to the machine where the agent runs.
- Start a task with [working with threads](/learn/threads/working-with-threads).
