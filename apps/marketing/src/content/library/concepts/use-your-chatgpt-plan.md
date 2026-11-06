---
title: "Use your ChatGPT plan with Codex in T3 Code"
description: "Use your ChatGPT plan in T3 Code through its Codex connection or an existing CLI login, then check the right account and reported limits."
updated: 2026-11-04
sources:
  - label: "Theo demonstrates Codex with his subscription"
    url: "https://www.youtube.com/watch?v=uLGxb4F3SyI&t=361s"
  - label: "Theo distinguishes Codex from the interface"
    url: "https://www.youtube.com/watch?v=xJaMTo2YgO8&t=362s"
  - label: "Codex provider guide"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-codex.md"
  - label: "Provider installation"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md"
  - label: "Usage and limits"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/usage.md"
  - label: "Official OpenAI authentication guidance"
    url: "https://learn.chatgpt.com/docs/auth"
  - label: "OpenAI terms of use"
    url: "https://openai.com/policies/terms-of-use/"
  - label: "OpenAI plan and feature guidance"
    url: "https://learn.chatgpt.com/docs/pricing"
faq:
  - question: "Can I use my ChatGPT plan in T3 Code?"
    answer: "T3 Code lets you connect ChatGPT through onboarding or Settings \u2192 Providers, or use an existing Codex CLI login. OpenAI controls which access and limits your account provides."
  - question: "Do I need an OpenAI API key to use Codex in T3 Code?"
    answer: "T3 Code supports ChatGPT sign-in for Codex without requiring an API key for that connection. API-key authentication is a separate usage-based option under OpenAI's rules."
  - question: "Does connecting ChatGPT change my Codex CLI login?"
    answer: "T3 Code's documented ChatGPT account connection leaves your CLI login unchanged. You can also configure T3 Code to use an existing Codex login."
  - question: "Why is my other Codex account missing from the thread picker?"
    answer: "T3 Code offers compatible Codex instances that share the thread's CODEX_HOME path. Check provider settings and each instance's reported account and shadow-home configuration."
---

T3 Code lets you use your ChatGPT plan with Codex through a ChatGPT connection or an existing Codex CLI login. Connect during onboarding or in `Settings → Providers`, then select the account for your work. OpenAI controls the plan's access, terms, and usage limits.

## Which sign-in path should you choose?

The current Codex guide documents two routes. Choose the one that matches your starting point:

| Starting point                                   | What to do                                                                   |
| ------------------------------------------------ | ---------------------------------------------------------------------------- |
| You want to connect ChatGPT from T3 Code         | Use onboarding or `Settings → Providers`; T3 Code handles Codex installation |
| You already use Codex CLI on the environment     | Use that installation and its existing login                                 |
| You need another account in T3 Code              | Add a ChatGPT account in provider settings                                   |
| You need isolated CLI configuration and sessions | Configure a separate Codex home                                              |

Theo demonstrates Codex using his subscription in T3 Code at 6:01 in _T3 Code broke me_. The durable idea is that you can direct an existing agent subscription from another interface. The [Codex provider guide](/learn/providers/codex) establishes the current connection steps.

OpenAI distinguishes [ChatGPT authentication from API-key authentication](https://learn.chatgpt.com/docs/auth). ChatGPT sign-in provides subscription access; API keys use API billing. Confirm the chosen account and authentication method before interpreting a usage figure.

## How do you connect ChatGPT from T3 Code?

1. [Install T3 Code](/download) and open onboarding or `Settings → Providers`.
2. If you are connecting another machine, select that environment first.
3. Start the ChatGPT connection and complete sign-in on OpenAI.
4. Allow sharing of your ChatGPT plan in that flow.
5. Choose the connected account from the thread's model picker.

Use the same account in T3 Code and on OpenAI's sign-in page when reconnecting. If remote sign-in cannot return automatically, paste the full URL from the final localhost page into the sign-in panel. Do this even when that final page could not load.

T3 Code's documented account connection leaves the CLI login unchanged. Disconnecting stops running threads while keeping their history, so you can reconnect later. Manage shared usage and credits in ChatGPT through `Manage usage` in T3 Code.

If a request needs a feature that ChatGPT sharing does not support, the provider guide directs you to use another provider for that request. A successful connection does not imply every feature has the same availability across authentication methods.

## How do you use an existing Codex CLI login?

Run the official login command on the environment's machine:

```bash
codex login
```

Complete the OpenAI browser flow with the account you intend to use. Check the account reported in T3 Code provider settings.

If T3 Code cannot discover your installed executable, set its `Binary path` in provider settings. The login and installation belong to the environment running the agent. Logging in on your viewing device does not configure a remote machine.

## How do multiple CLI accounts share threads?

The documented shared-thread setup uses a common `CODEX_HOME path` plus a separate shadow home for the second account. Keep the first account in `~/.codex`, then create a fresh login directory for the second:

```bash
mkdir -p ~/.codex_personal
CODEX_HOME=~/.codex_personal codex login
```

Add a second Codex instance in `Settings → Providers`. Set both instances' `CODEX_HOME path` to `~/.codex`. Give the second instance a `Shadow home path` of `~/.codex_personal`.

T3 Code prepares shared state in the shadow directory. Do not copy your entire Codex home into it. The shadow account needs its own `auth.json`; follow the linked OpenAI credential-storage guidance if your CLI uses an OS credential store.

Choose a completely separate Codex home without a shadow home when you want separate sessions and configuration. That instance cannot continue threads from the other home. This differs from [Claude's separate account directories](/learn/concepts/use-your-claude-subscription).

Codex can also request access to another app. Respond to the named request in the thread. Read [permission modes](/learn/safety/permission-modes) for command and file approvals.

## Where do you check limits?

Open `Usage → Limits` for the allowance information T3 Code can retrieve. The Usage page's estimated API-equivalent costs are not your subscription bill. When Codex stops on a reported limit, read the window and reset information in the thread.

Consult [OpenAI's plan guidance](https://learn.chatgpt.com/docs/pricing) for current entitlements and limits. Follow [OpenAI's terms](https://openai.com/policies/terms-of-use/) and the agreement applicable to your account. Older videos' usage comparisons do not establish a current quota or a guaranteed number of agent runs.

## Next steps

Follow [the Codex provider guide](/learn/providers/codex) and [Usage and limits](/learn/customize/usage-and-limits) for setup and troubleshooting.

Return to [Ideas behind T3 Code](/learn/concepts) to understand how accounts fit into the wider workflow.
