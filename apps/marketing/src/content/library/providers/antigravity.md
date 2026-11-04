---
title: "Use Antigravity in T3 Code"
description: "Set up Antigravity in T3 Code, choose Google or API authentication, finish remote sign-in, and understand models, approvals, and conversation limits."
updated: 2026-11-04
sources:
  - label: "Provider setup"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md"
  - label: "Permission modes"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md"
  - label: "Antigravity setup and capabilities"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-antigravity.md"
faq:
  - question: "Does T3 Code use my Antigravity IDE login?"
    answer: "No. T3 Code runs the Antigravity ACP agent with its own sign-in, separate from the IDE or CLI. Configure it in Settings > Providers for the environment running your project."
  - question: "How do I finish remote Antigravity sign-in?"
    answer: "Copy the full final 127.0.0.1 return URL into the return URL field in the T3 Code client where sign-in started. Preserve the query string and wait for T3 Code to confirm access."
  - question: "Can T3 Code use a Gemini API key with Antigravity?"
    answer: "Yes. Select Gemini API key as the sign-in method in T3 Code Antigravity settings and choose Connect. Ambient Gemini credentials do not override the instance's selected method."
  - question: "Can I rewind an Antigravity conversation in T3 Code?"
    answer: "No. T3 Code retains history and diffs, but Antigravity cannot rewind its conversation. Revert and editing an earlier turn for resubmission are unavailable."
---

T3 Code runs Google's Antigravity ACP agent on your selected environment. Antigravity is a coding agent with its own account access and models; its sign-in is separate from the Antigravity IDE or CLI.

## Install and connect Antigravity

1. [Install T3 Code](/download) and open `Settings > Providers` on web or desktop.
2. Select the environment that runs your project and enable Antigravity.
3. Install its runtime on that environment.
4. Choose `Sign in` and complete the selected authentication flow.
5. Wait for T3 Code to confirm access and load models before starting a thread.

After runtime installation, mobile also offers sign-in in `Settings > Providers`. Installation continues when you leave settings or reconnect. Setup requires permission to operate the environment. Update an older server if the setup action is unavailable.

Managed installation supports Apple Silicon macOS, Linux x64 or ARM64, and Windows x64 or ARM64. Intel Macs can connect to a supported remote environment. Allow several GB of free space, particularly on Linux.

## Choose the account or API authentication method

Select `Sign-in method` in Antigravity provider settings.

| Method                     | Required credentials or configuration                                     |
| -------------------------- | ------------------------------------------------------------------------- |
| Google account             | Personal Google browser sign-in                                           |
| Gemini Enterprise          | Browser sign-in, GCP project, and GCP location                            |
| Gemini API key             | API key, then Connect without a browser                                   |
| Agent Platform / Vertex AI | API key, or GCP project and location with Application Default Credentials |

The selected method and credentials belong to the instance. Ambient `GEMINI_API_KEY` or Google credential variables do not override that selection. T3 Code stores the instance's API key outside its settings file; clients see whether a key is saved.

Changing authentication methods stops the instance's sessions. To replace an account, sign out first, then sign in. Google determines the account access and models available through the agent.

## Finish browser sign-in from another device

Google returns to a `127.0.0.1` URL. That listener lives on the environment machine. A browser running elsewhere will usually show a failed final page.

Copy that complete return address into the return URL field in the client where you started sign-in. Keep everything after `?` and select `Continue`. Do not substitute the server's hostname. Only the original T3 Code sign-in session can finish the attempt; if it expires, retry with a new link.

The address contains a temporary sign-in code, so paste it only into the setup field. A successful callback page does not prove account access. Wait for the confirmation inside T3 Code. The [remote access guide](/learn/remote/remote-access) explains the environment and client distinction.

## Use a manual runtime when needed

Download the environment's archive from the [official ACP Registry](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json). Extract the ACP executable and its `localharness_external` helper together, at the same version. Make both executable on macOS or Linux. Windows uses `.exe` files.

Set `Binary path` to the ACP executable and maintain that installation yourself. Leaving the field blank selects the managed runtime, or a compatible executable on `PATH` when no managed runtime is installed.

## Choose models, planning, and permissions

The account supplies the model catalog, including Claude and GPT models when the plan includes them. Thinking controls show only the levels the selected model supports. A resumed thread keeps its model. Select another available model if access to the saved one ends.

Use Antigravity's native `/plan` command. T3 Code's separate Plan mode is unavailable. Tool requests follow [permission modes](/learn/safety/permission-modes), with remembered approvals only for actions that support them. Native requests can still appear in Full access. Fixed-choice questions still require an offered answer.

Conversation rewind is unavailable. T3 Code keeps history and file diffs, but cannot revert the Antigravity conversation or resubmit an edited earlier turn. Manual compaction is also unavailable through this ACP runtime, even though its CLI has `/compact`. Use a follow-up or start a new thread when you need fresh context.

## Load skills and inspect subagent work

Use `.agents/skills` for project skills. T3 Code also reads `.gemini/skills` and legacy `.agent/skills`, with the first copy winning in that order: `.gemini/skills`, `.agents/skills`, `.agent/skills`.

Global skills belong in `~/.gemini/config/skills` or `~/.gemini/antigravity-cli/skills`. Antigravity does not normally read `~/.agents/skills`.

Subagent batches offer a read-only work view. Open a batch and select `Subagent work`, or `Work` on mobile, to inspect roles, prompts, and recent steps. An idle batch does not establish that every child succeeded. Send further direction through the parent rather than trying to control an individual child.

## Check access and account state

Refresh provider status on web or desktop, or refresh models from mobile thread settings. A server restart keeps Google sign-in. If Google reports `SUBSCRIPTION_REQUIRED`, an account restriction, or a limit, follow its message and any retry time.

Add separate instances for separate Google accounts. Disabling an instance stops its sessions and keeps sign-in. Signing out removes the saved Google login. Both retain history and workspace files. Downloaded runtimes are shared across instances.

## Next steps

- Compare the dedicated integration with [generic ACP agents](/learn/providers/acp-agents) and other [coding agents](/learn/providers).
- Read [Usage and limits](/learn/customize/usage-and-limits) for Google allowance reporting.
- Use [messages and context](/learn/threads/messages-and-context) when attaching files to a task.
