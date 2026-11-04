---
title: "Permissions and privacy"
description: "Choose T3 Code permissions, understand which data leaves your machine, and configure access, telemetry, and managed policy for your environment."
updated: 2026-11-04
sources:
  - label: "Permission modes"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md"
  - label: "Managed policy"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/managed-policy.md"
  - label: "Product usage data"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/telemetry.md"
  - label: "Background service"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/background-service.md"
  - label: "Outside agents"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/outside-agents.md"
  - label: "Privacy policy source"
    url: "https://github.com/pingdotgg/t3code/blob/main/apps/marketing/src/pages/privacy-policy.astro"
  - label: "Security policy source"
    url: "https://github.com/pingdotgg/t3code/blob/main/apps/marketing/src/pages/security-policy.astro"
faq:
  - question: "What safety controls does T3 Code provide?"
    answer: "T3 Code provides thread permission modes, managed machine policy, and access grants for outside agents. Data controls include a server telemetry opt-out and a separate mobile crash-report setting."
  - question: "Does T3 Code keep all data on my machine?"
    answer: "T3 Code sends prompts and selected files to the providers you configure. Product usage events and optional remote services have separate data flows, described in the privacy policy."
  - question: "Can an administrator restrict T3 Code?"
    answer: "T3 Code managed policy can limit providers, permission modes, client access, and other capabilities. The server enforces the policy for connected desktop, browser, and mobile clients."
---

T3 Code gives you controls for agent approvals, environment access, and product usage data. Start by separating what an agent may do from where your data goes. A permission mode controls approvals; it does not change a provider's privacy terms.

## Decide what an agent may do

Use [permission modes](/learn/safety/permission-modes) to choose how a thread handles commands and file changes. Supervised asks for approval, Auto-accept edits approves file changes, Auto uses provider review where supported, and Full access removes ordinary approval prompts. Provider behavior can differ, so check the exceptions before choosing a mode for unattended work.

For a team, use [managed policy](/learn/safety/managed-policy) to set defaults and enforce limits on each host machine. Policy can cap permission modes and restrict providers. It also lets administrators turn off specific capabilities, including product usage events and browser cookie import. A policy requires a server restart before a change takes effect.

## Understand what leaves the machine

Read [security and privacy](/learn/safety/security-and-privacy) before deciding whether a project belongs in an environment. Prompts and selected files reach the coding providers you choose. Optional T3 Connect and notification features process the information they need. The [privacy policy](/privacy-policy) and [security policy](/security-policy) are the authoritative descriptions of those practices and responsibilities.

[Product usage data and telemetry](/learn/safety/product-usage-data) explains the default usage events, the server opt-out, and separate mobile diagnostics. Usage events exclude prompts, responses, file contents, and authentication tokens. That exclusion describes analytics payloads; it does not describe every network request a feature makes.

## Choose how other devices and agents connect

A [background service](/learn/safety/background-service) keeps an environment running without an open terminal on supported systems. Its lifetime, network exposure, and T3 Connect sign-in are separate choices. Inspect the host's status before assuming it is reachable from another device.

[Outside agents](/learn/safety/outside-agents) connect through an environment's MCP endpoint. Start with the default read-only grant when an agent needs to inspect projects or threads. A broader grant lets it steer threads in every project, subject to the permission ceiling you approve.

## Match the control to the task

| Your task                                             | Start here                                       |
| ----------------------------------------------------- | ------------------------------------------------ |
| Review commands before they run                       | Thread permission mode                           |
| Apply a company rule across connected clients         | Managed machine policy                           |
| Stop server product events                            | Telemetry environment variable or managed policy |
| Keep remote access available after closing a terminal | Background service                               |
| Give a terminal or hosted agent access                | MCP sign-in and access grant                     |

## Next steps

[Verify the official T3 Code download](/learn/start/verify-official-download) before installing from [the download page](/download). Return to the [full library](/learn) for provider setup and remote-access guides.
