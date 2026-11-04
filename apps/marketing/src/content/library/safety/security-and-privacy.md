---
title: "Security and privacy in T3 Code"
description: "Understand T3 Code security and privacy, which data reaches providers and T3 services, and how to control permissions, telemetry, and secrets."
updated: 2026-11-04
sources:
  - label: "Privacy policy source"
    url: "https://github.com/pingdotgg/t3code/blob/main/apps/marketing/src/pages/privacy-policy.astro"
  - label: "Security policy source"
    url: "https://github.com/pingdotgg/t3code/blob/main/apps/marketing/src/pages/security-policy.astro"
  - label: "Product usage data"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/telemetry.md"
  - label: "Environment authentication"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/internals/environment-auth.md"
  - label: "T3 Connect architecture"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/internals/t3-connect.md"
  - label: "Permission modes"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md"
  - label: "Outside agents"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/outside-agents.md"
  - label: "Managed policy"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/managed-policy.md"
  - label: "Secret request implementation"
    url: "https://github.com/pingdotgg/t3code/blob/main/apps/server/src/secrets/SecretRequests.ts"
  - label: "Secret request tool and behavior"
    url: "https://github.com/pingdotgg/t3code/blob/main/apps/server/src/mcp/toolkits/orchestrator/tools.ts"
  - label: "Secret request result contract"
    url: "https://github.com/pingdotgg/t3code/blob/main/packages/contracts/src/secretRequest.ts"
  - label: "Agent instructions for secrets"
    url: "https://github.com/pingdotgg/t3code/blob/main/packages/provider-core/src/server/orchestrationInstructions.ts"
  - label: "Secret request card"
    url: "https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/chat/SecretRequestCard.tsx"
faq:
  - question: "Is T3 Code safe to use?"
    answer: "T3 Code provides approval modes, scoped environment access, and protected credential storage where supported. Safety also depends on your host, connected providers, and access grants; the security policy describes these shared responsibilities."
  - question: "Does T3 Code send my code to its servers?"
    answer: "T3 Code product usage events exclude file contents, prompts, and responses. Prompts and selected files go to your configured providers, and optional remote features can carry session traffic through T3 Connect infrastructure."
  - question: "Where is the official T3 Code privacy policy?"
    answer: "The official T3 Code privacy policy is at https://t3.codes/privacy-policy. The security policy is at https://t3.codes/security-policy."
  - question: "Does T3 Code use my code to train AI?"
    answer: "The T3 Code privacy policy says T3 Tools does not use personal information, source code, prompts, or agent responses to train AI models. Your chosen coding providers have their own terms and privacy policies."
  - question: "How do I give an agent an API key in T3 Code?"
    answer: "T3 Code agents can request a secret through a private card with request_secret. The normal flow returns a one-use reference; command delivery instead creates an owner-only file that the command can read."
---

T3 Code connects your clients and environments to coding agents you choose, with controls for approvals and access. Product usage events exclude source files, prompts, and responses, while your configured providers receive prompts and selected files. Optional remote services have additional data flows, so assess safety using the [privacy policy](/privacy-policy), [security policy](/security-policy), and your environment's settings.

## Does T3 Code send my code to its servers?

Separate the destination and purpose of each transfer. A usage event, a model request, and a remote connection carry different information.

| Data or feature                            | What leaves the host or device                                                                                      | Destination                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Coding-agent requests                      | Prompts, selected files, and related context you direct to an agent                                                 | Configured coding agents and AI providers           |
| Product usage events                       | Provider, public model name where available, mode, result, duration, versions, token counts, and hashed identifiers | `ingest.t3.codes`, with events forwarded to PostHog |
| T3 account sign-in                         | Account identifiers and profile or authentication information                                                       | T3 account services and authentication providers    |
| T3 Connect                                 | Environment and device identifiers, connection information, public keys, credential hashes, status, and preferences | T3 Connect services                                 |
| Optional notifications and Live Activities | Push tokens and limited activity information, including project or thread titles, model, status, and headline       | Services delivering those features                  |
| Optional offline webhook holding           | Raw webhook requests, including the hook token in the path, when holding is enabled                                 | T3 Connect relay storage                            |
| Relay diagnostics                          | Connection traces used for troubleshooting                                                                          | Axiom                                               |
| Configured OpenTelemetry export            | Traces, metrics, or logs for enabled signals                                                                        | The receiver endpoints you configure                |
| Mobile diagnostics                         | Error messages, stacks, versions, device information, startup timings, and a random install ID                      | Axiom through the T3 Connect relay                  |

The website and online services can also log IP addresses, browser or app details, access times, errors, and other operational metadata. Support receives information you choose to provide. Mobile error messages can quote values the app was processing. Consult the privacy policy for the full categories and applicable choices.

T3 Code's product events do **not** include prompts, responses, file contents, authentication tokens, conversation IDs, raw provider events, or child-agent output. Data stored only on your device is not collected by T3 Tools unless a feature transmits it. These boundaries do not mean that using a cloud coding provider keeps code offline.

For remote use, T3 Connect brokers access and provides managed tunnels. After bootstrap, application traffic uses the environment's tunnel hostname; the relay Worker does not proxy ordinary HTTP or WebSocket sessions. Traffic still uses tunnel infrastructure. The policy describes processing needed for enabled features, so do not infer that all remote traffic stays on your LAN.

## Which privacy choices should I check first?

1. [Verify the official download](/learn/start/verify-official-download) and install or update from [t3.codes](/download).
2. Review the terms of the coding provider configured for your project.
3. Inspect which remote, notification, and diagnostic features you use.
4. Set the server telemetry opt-out if you do not want product usage events or server relay tracing.
5. Revoke devices or outside agents you no longer use.

The [usage data guide](/learn/safety/product-usage-data) explains `T3CODE_TELEMETRY_ENABLED=false` and the separate mobile crash-report switch. The browser does not read the server's environment variables. Treat each surface's diagnostics as a separate check.

The policy says T3 Tools does not use your personal information, source code, prompts, or agent responses to train AI models. This statement does not set the practices of the provider you connect. Review that provider's policy before sending sensitive project material.

## How do approvals and environment access protect work?

Choose [a permission mode](/learn/safety/permission-modes) for each thread. Full access permits commands and edits without ordinary approval prompts, and it is the initial default for new threads. Provider settings and safety checks can still affect execution.

A project organizes work inside an environment. It is not a filesystem sandbox. Environment filesystem access can reach files the server account can read, including absolute paths outside a project. Use an account and machine whose accessible data matches the work you intend to permit.

For teams, [managed policy](/learn/safety/managed-policy) limits capabilities across clients connected to that host. For integrations, [outside-agent grants](/learn/safety/outside-agents) start read-only and can cap the permissions of threads an agent steers. Do not approve an integration sign-in you did not initiate.

## How should I provide secrets to an agent?

T3 Code supports `request_secret` for a login, token, PIN, or pairing code that only you can supply. The agent opens a private card rather than asking you to paste the value into chat. The normal flow returns a one-use `secretRef` for a supported T3 tool, while orchestration records request status rather than the secret value.

When a secret card appears, review its reason, enter the value, and select **Save securely**. Select **Decline** if you do not want to provide it.

A command that needs a credential can use file delivery. That flow writes an owner-only file and returns its path. The command can read the value, so file delivery grants access to the process executing that command. It does not make the secret inaccessible to software running as your user.

Declining the card tells the agent to explain what is blocked and continue without the secret. Moving a value already pasted in chat into a private file does not undo its earlier exposure. Prefer the card before the value enters a conversation.

## Where do I report a vulnerability?

Report suspected T3 Code vulnerabilities to [security@ping.gg](mailto:security@ping.gg), as directed by the [security policy](/security-policy). Include the affected component, reproduction steps, and sanitized evidence. Read the policy before testing or disclosing an issue. Privacy requests go to [privacy@t3.tools](mailto:privacy@t3.tools).

## Next steps

Use the [permissions and privacy overview](/learn/safety) to choose the next control to configure. If the environment must stay available remotely, review [background service behavior](/learn/safety/background-service) before leaving it unattended.
