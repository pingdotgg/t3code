---
title: "Use OpenCode in T3 Code"
description: "Run OpenCode in T3 Code with a local or external server, check supported versions, configure authentication, and resolve approvals and model refreshes."
updated: 2026-11-04
sources:
  - label: "Provider setup"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md"
  - label: "Permission modes"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md"
  - label: "OpenCode versions, servers, and approvals"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-opencode.md"
  - label: "OpenCode subscription limits"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/usage.md"
faq:
  - question: "Can T3 Code use an existing OpenCode server?"
    answer: "Yes. Set Server URL and its password in the T3 Code OpenCode provider settings. External servers must meet the documented OpenCode version requirement."
  - question: "Does T3 Code support OpenCode 2?"
    answer: "T3 Code supports OpenCode 2.0.18 and newer and detects the major version automatically. Install @opencode/cli yourself to move from 1.x; the update button does not switch packages."
  - question: "Why does OpenCode Auto still ask for approval?"
    answer: "T3 Code applies Supervised rules to OpenCode Auto because OpenCode has no AI approval reviewer. Environment files can also require approval in restricted modes."
  - question: "Why are new OpenCode models missing?"
    answer: "Refresh provider status in T3 Code after login or configuration changes. An external OpenCode server can require its own reload or restart."
---

T3 Code runs OpenCode through a local server it starts or an existing server you configure. OpenCode is a coding agent with its own authentication and configuration; install and authenticate it on the environment before enabling the provider.

## Install and enable OpenCode

1. [Download T3 Code](/download) if needed.
2. Install [OpenCode](https://opencode.ai) on the machine hosting the environment.
3. Run `opencode auth login` there to configure OpenCode authentication.
4. Open `Settings > Providers`, select the environment, and enable OpenCode.
5. Refresh provider status and select a model for your thread.

Set `Binary path` if the executable is not on the server's `PATH`. Authentication belongs to OpenCode. A password used for the OpenCode server connection is a separate credential from the login used to access models.

T3 Code requires OpenCode 1.14.19 or newer, including for an external server. OpenCode 1.x displays Limited support. T3 Code supports OpenCode 2.0.18 and newer and detects which runtime to use from the installed version.

## Move from OpenCode 1.x to 2.x

OpenCode 2 uses a separate package. Install it yourself, then refresh provider status:

```bash
npm install -g @opencode/cli
```

T3 Code's update button updates the package already installed. It does not replace a 1.x installation with 2.x.

OpenCode 2 converts the shared database when it first runs. Do not run 1.x and 2.x side by side on the same machine. Threads started with 1.x can continue with 2.x. Decide which version the environment will use before opening both versions against shared state.

## Choose a local or external server

| Goal                                   | Provider setting                      |
| -------------------------------------- | ------------------------------------- |
| Let T3 Code start OpenCode             | Leave `Server URL` empty              |
| Connect an existing server             | Set `Server URL` and its password     |
| Password-protect the T3-started server | Set the password in provider settings |

For a local server, the configured password applies to both the server and T3 Code's connection. Without that setting, the local server uses `OPENCODE_SERVER_PASSWORD` from its environment.

For an external server, T3 Code uses only the configured password. It does not forward a local `OPENCODE_SERVER_PASSWORD`. If the connection fails, check the URL, configured password, and server version before refreshing provider status.

After a lost connection, send another prompt to reconnect to the same OpenCode session. External server configuration belongs to that server, so local file changes do not establish that it has reloaded.

## Decide how broadly to approve a request

OpenCode follows T3 Code's shared permission modes, with one exception: Auto uses the same rules as Supervised because there is no AI approval reviewer.

Normal file reads can continue without approval, but `.env` and `.env.local` require approval in restricted modes. `.env.example` is allowed. This distinction explains why one read prompts while another does not.

`Allow for workspace` can apply to matching requests in other OpenCode sessions using the same workspace. Its scope matters on a shared external server. Choose `Allow once` for a single request. Denying a request does not stop the whole turn.

Read [permission modes](/learn/safety/permission-modes) before using remembered approvals as a convenience across several threads.

## Refresh models without keeping stale configuration alive

After changing login or configuration, choose `Refresh provider status` under `Settings > Providers` for the correct environment. On mobile, use `Refresh models` in thread settings. Reconnecting also refreshes the catalog; periodic health checks do not.

Native configuration can remain cached while the local helper runs. Leave it idle for 30 seconds without model refreshes or text-generation work, then refresh again. Repeated refreshes keep the helper alive. An external server may need its own restart.

A thread retains a selected model even after that model disappears from the catalog. If OpenCode rejects it, select an available model and retry. Refreshing does not silently replace your saved selection.

## Use planning, compaction, and subscription reporting

Plan mode uses OpenCode's `plan` agent. OpenCode also controls its own automatic compaction; T3 Code has no compaction setting for it. On version 2, use the `compaction` section in an OpenCode config such as `opencode.json`. The documented controls include `auto`, `buffer`, and `keep.tokens`. Send `/compact` for manual compaction.

OpenCode Go limits are available only for OpenCode running locally in the environment. They require a Go API key or an API-key-connected Console account. A Console browser login alone does not report limits. An instance can supply `OPENCODE_API_KEY` through its environment variables, followed by a status refresh.

## Next steps

- Compare OpenCode with [other coding agents](/learn/providers), including [ACP Registry agents](/learn/providers/acp-agents).
- Check [Usage and limits](/learn/customize/usage-and-limits) to separate quota reporting from estimated cost.
- Start a task with the [threads guide](/learn/threads/working-with-threads).
