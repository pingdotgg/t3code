---
title: "Let outside agents drive T3 Code"
description: "Connect outside agents to T3 Code over MCP, approve read-only or capped access, choose a reachable URL, and revoke integrations when work ends."
updated: 2026-11-04
sources:
  - label: "Outside agents"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/outside-agents.md"
  - label: "Environment authentication"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/internals/environment-auth.md"
  - label: "Permission modes"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md"
  - label: "Launch walkthrough at 31:00"
    url: "https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1860s"
faq:
  - question: "Can ChatGPT connect to T3 Code?"
    answer: "T3 Code exposes an environment MCP endpoint for hosted agents such as ChatGPT. Use the T3 Connect address, select OAuth, and approve the sign-in with the access level you intend."
  - question: "What can an outside agent read in T3 Code?"
    answer: "T3 Code read-only access allows an agent to read projects and threads and inspect available providers and models. It does not permit changes."
  - question: "Why does my T3 Code MCP sign-in fail on a LAN address?"
    answer: "T3 Code outside-agent credentials are sent only over HTTPS or to localhost. A plain HTTP LAN or Tailscale address can support discovery without completing sign-in."
  - question: "How do I revoke an outside agent in T3 Code?"
    answer: "Open T3 Code Settings → Sharing & access and revoke the approved agent. Revocation cuts off access immediately; a sign-in otherwise lasts 30 days."
---

T3 Code lets agents it did not start connect to an environment through MCP. You approve each agent's sign-in and choose read-only access or a permission ceiling for threads it can steer. This works for supported terminal agents, hosted agents such as ChatGPT, and bots with HTTP MCP and OAuth support.

## Choose an access level before connecting

Start by deciding whether the integration needs to inspect work or change it. Read only is the default. Broader grants apply across the environment's projects, so choose access for the whole environment rather than one intended prompt.

| Grant                          | What the outside agent can do                                     |
| ------------------------------ | ----------------------------------------------------------------- |
| Read only                      | Read projects and threads; inspect available providers and models |
| Supervised through Full access | Also start, message, and stop threads in every project            |

A thread the outside agent starts or steers cannot run above its approved permission ceiling. That ceiling is separate from the thread's current [permission mode](/learn/safety/permission-modes). Read-only access does not include permission to change anything.

An outside MCP connection is also different from [adding an ACP provider](/learn/providers/acp-agents). MCP gives another agent access to an existing environment. A provider integration determines which agent runtime T3 Code itself runs.

## Copy a URL the agent can reach

In **Settings → Environments**, open the saved environment's menu and select **Copy MCP URL**. The endpoint is its address with `/mcp` appended:

```text
https://<environment-address>/mcp
```

The copied address follows the route your current device uses. That makes it suitable for an agent on that device, but another machine may need another route. Theo's [launch walkthrough at 31:00](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1860s) also shows the MCP URL entry point.

For an agent on your computers, use `localhost` on the host, T3 Connect, or another HTTPS address such as Tailscale HTTPS. Credential exchange requires HTTPS or localhost. A plain HTTP LAN or Tailscale address can discover an environment without completing sign-in.

For a hosted agent, use the T3 Connect address. The endpoint must be reachable from the internet. A Tailscale address is available only within your tailnet, so it does not provide a route for a hosted service outside that network.

## Approve a sign-in you initiated

The first connection opens an environment sign-in page. Inspect the agent name and the destination receiving access. A local agent returns approval to localhost on the computer that opened the page. A hosted agent sends it to that service, such as `chatgpt.com`.

Only approve a sign-in you started. A service operator receiving approval gets the granted access. A familiar-looking page does not establish why someone else sent you its link.

To approve:

1. Get a pairing code from **Settings → Sharing & access** or `t3 auth pairing create` on the host.
2. Enter it on the environment sign-in page.
3. Choose read-only access or the runtime permission ceiling you intend.
4. Finish sign-in and confirm the agent reports a connection.

A browser already signed in with permission to manage access can approve without a code. The environment, rather than the cloud account alone, issues and enforces the grant. Read [security and privacy](/learn/safety/security-and-privacy) before approving access to sensitive projects.

## Connect Claude Code or Codex

For Claude Code in your terminal:

```sh
claude mcp add --transport http t3 https://<environment-address>/mcp
claude mcp login t3
claude mcp list
```

For Codex:

```sh
codex mcp add t3 --url https://<environment-address>/mcp
codex mcp login t3
codex mcp list
```

Replace the placeholder with the environment's reachable address. Login opens the approval page. On a machine without a browser, use the documented `--no-browser` login option and open the printed URL elsewhere. Claude's flow asks you to paste the final URL back. After approval, its list shows `t3` connected; Codex shows it with OAuth.

## Connect ChatGPT or another hosted agent

In ChatGPT's apps settings, create a custom MCP app or plugin. Set its server URL to the T3 Connect endpoint ending in `/mcp`, and choose OAuth. Discovery supplies the required sign-in configuration, so you do not need a client ID or secret.

Create the integration and approve the resulting environment sign-in. Other bots need support for remote MCP over HTTP with OAuth. An agent without OAuth support cannot connect through this flow.

Keep the host running for remote agents. On supported hosts, the [background service guide](/learn/safety/background-service) explains how to keep an environment available without an open terminal.

## Revoke access and diagnose failures

Approved agents appear in **Settings → Sharing & access** alongside other clients. Revoke one there to cut off access immediately. Otherwise a sign-in lasts 30 days, after which the agent asks for approval again.

For failed sign-in, check reachability first, then HTTPS or localhost, then OAuth support. For an agent that can read but cannot start work, inspect the grant you approved. For work that waits for approvals, inspect the thread mode and the outside agent's ceiling.

## Next steps

Review [permissions and privacy](/learn/safety) before granting another integration access. Use [permission modes](/learn/safety/permission-modes) to decide how much action an outside agent should be able to request.
