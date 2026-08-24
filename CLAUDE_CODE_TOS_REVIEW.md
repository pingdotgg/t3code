# Claude Code CLI Integration and Terms Review

**Review date:** August 24, 2026

**Repository commit reviewed:** `643daa51616d0bfcd4c8235ae6966a68f106dcfe`

> This is a technical review of the repository against Anthropic's published terms and guidance. It
> is not legal advice and cannot verify agreements or permissions held outside the repository.

## Executive summary

T3 Code's core Claude Code integration is substantially aligned with Anthropic's currently
documented permitted pattern. T3 runs the user's unmodified Claude Code executable through
Anthropic's public Agent SDK, leaves authentication to Claude Code's own login flow, and does not
appear to extract or proxy Claude OAuth credentials. A single person controlling their own host with
their own Claude subscription, including from another one of their devices, therefore appears to be
a permitted use.

The repository alone does not support an unconditional compliance conclusion. Anthropic requires a
product that runs Claude Code to agree to its Commercial Terms, which cannot be verified in source
code. T3's environment-level provider authentication also creates a multi-user risk: allowing a
second person to control a host authenticated with the first person's Claude subscription would
conflict with the requirement that each end user authenticate with their own credentials. In
addition, T3 includes the Claude logo in its UI and marketing; Anthropic's current guidance requires
permission for logo use beyond accurate plain-text references.

## Integration architecture

T3 uses one runtime boundary:

```text
Web / desktop / mobile client
              |
       authenticated T3 RPC
              |
        T3 server on host
          +---+---------------+
          |                   |
 Claude Agent SDK       Codex app-server
          |                   |
 user's `claude`        user's `codex`
          |                   |
 Anthropic service       OpenAI service
```

The T3 server owns provider processes, provider authentication, sessions, filesystem operations,
and orchestration. Remote clients control that server rather than contacting Anthropic or OpenAI
directly. Hosted pairing connects the client directly to the user's T3 backend; the hosted T3 web
application does not proxy HTTP or WebSocket application traffic. See
[`docs/internals/remote.md`](docs/internals/remote.md).

### Claude Code

- Users install Claude Code and authenticate normally with `claude auth login`; T3 does not provide
  its own Claude.ai login flow. See
  [`docs/user/providers-claude.md`](docs/user/providers-claude.md).
- The server uses `@anthropic-ai/claude-agent-sdk` and its public `query()` interface. It supplies the
  user's configured executable through `pathToClaudeCodeExecutable`, streams prompts and events,
  resumes sessions, and maps SDK tool-permission callbacks to T3's approval UI. See
  [`apps/server/src/provider/Layers/ClaudeAdapter.ts`](apps/server/src/provider/Layers/ClaudeAdapter.ts).
- The SDK's platform-specific bundled binaries are deliberately excluded because T3 always uses the
  user's Claude executable. See [`pnpm-workspace.yaml`](pnpm-workspace.yaml).
- Windows launcher handling resolves an npm shim to the published package entry without patching the
  Claude Code binary. See
  [`apps/server/src/provider/Drivers/ClaudeExecutable.ts`](apps/server/src/provider/Drivers/ClaudeExecutable.ts).
- No Claude integration code was found that reads `.credentials.json`, OAuth access or refresh
  tokens, or `CLAUDE_CODE_OAUTH_TOKEN`. Normal subscription credentials remain managed by Claude
  Code and the operating system keychain/configuration.
- Custom API or gateway credentials can be stored as T3 server secrets. This is distinct from
  intercepting Claude.ai OAuth, but the credential must still belong to the user or organization
  whose authorized users generate the usage.

### Codex

T3 launches the user's `codex app-server` process and communicates with it over its JSON-RPC stdio
protocol. It uses app-server operations for account and model discovery, thread and turn lifecycle,
streamed events, and approvals. See
[`apps/server/src/provider/Layers/CodexProvider.ts`](apps/server/src/provider/Layers/CodexProvider.ts)
and
[`apps/server/src/provider/Layers/CodexSessionRuntime.ts`](apps/server/src/provider/Layers/CodexSessionRuntime.ts).

This is the integration boundary OpenAI documents for embedding Codex into rich clients, including
authentication, conversation history, approvals, and streamed agent events. See the official
[Codex App Server documentation](https://developers.openai.com/codex/app-server).

## Comparison with Anthropic's published requirements

Anthropic's current
[Claude Code legal and compliance guidance](https://code.claude.com/docs/en/legal-and-compliance)
allows products and hosted agent infrastructure to run Claude Code when the following conditions are
met:

1. The product operator agrees to Anthropic's Commercial Terms.
2. The Claude Code binary remains unmodified and its built-in authentication methods are not removed,
   disabled, or restricted.
3. Each end user authenticates with their own Claude subscription, Anthropic API key, or approved
   third-party inference-provider credential.
4. The product does not pay for, resell, or intermediate Claude usage for end users.
5. The product does not collect or intermediate Claude.ai credentials or session tokens, and Claude
   account sign-in completes through Anthropic's own flow.
6. Branding does not imply that Anthropic built, endorsed, or partnered with the product.

The Agent SDK is itself governed by Anthropic's Commercial Terms when used to power a product. See
the official [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview#license-and-terms).
T3's MIT license covers T3's code, but does not supersede the terms applicable to Anthropic's SDK,
binary, services, or trademarks.

## Findings

### Aligned with the permitted integration model

- T3 runs the user's executable instead of distributing a modified Claude Code binary.
- It uses Anthropic's supported Agent SDK rather than scraping the terminal UI or reverse-engineering
  Anthropic's network protocol.
- Authentication is performed through `claude auth login`, outside T3, using Anthropic's own flow.
- The review found no handling of Claude.ai OAuth or session tokens in the provider integration.
- T3 does not purchase or resell Claude tokens. Its own terms say users bring their provider and
  remain responsible for provider charges. See
  [`apps/marketing/src/pages/terms-of-service.astro`](apps/marketing/src/pages/terms-of-service.astro).
- T3 has its own product identity, and accurate plain-text statements that it runs Claude Code are
  permitted by Anthropic's published guidance.

### Conditions and risks that remain

#### 1. Commercial Terms acceptance cannot be verified

Anthropic says that running Claude Code in a product or service requires agreement to its
[Commercial Terms](https://www.anthropic.com/legal/commercial-terms), unless the parties agree
otherwise. Whether T3 Tools, Inc. has accepted those terms or has a separate agreement is external to
the repository and must be confirmed before treating the product as fully compliant.

#### 2. One provider identity must not be shared between people

A T3 execution environment owns provider availability and authentication. T3 remote authentication
authorizes a client to control that environment; it does not establish a separate Claude identity for
each human controlling it.

Remote control by the same person from their own laptop, browser, or phone appears consistent with
Anthropic's guidance. Giving another person access to a host authenticated with the owner's personal
Free, Pro, or Max account would make that Claude account available to someone else. That conflicts
with Anthropic's [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) and the product
condition requiring each end user to use their own credentials.

For a shared organizational environment, use an organization-owned API or supported cloud-provider
credential under the Commercial Terms, restrict access to the key owner's authorized users, and do
not resell or allocate the resulting usage as a separate T3 service. Otherwise, isolate one T3
environment and Claude authentication context per human user.

#### 3. Claude logo use needs permission

T3 includes the Claude/Anthropic mark in its marketing and provider UI, including
[`apps/marketing/public/harnesses/claude-ai-icon.svg`](apps/marketing/public/harnesses/claude-ai-icon.svg),
[`apps/web/src/pierre-icons.ts`](apps/web/src/pierre-icons.ts), and
[`apps/mobile/src/components/ProviderIcon.tsx`](apps/mobile/src/components/ProviderIcon.tsx).

Anthropic permits accurate plain-text statements that a product runs Claude Code, but says other use
of its names and logos is governed by its trademark rules and requires written permission. If T3
does not have that permission, the Claude logo should be replaced with a neutral provider glyph or a
text-only label. The in-product label `Claude` is consistent with the Agent SDK branding guidance.

#### 4. OpenRouter and Claude Code Router are not clearly covered

T3 documents using Claude Code with OpenRouter and Claude Code Router in
[`docs/user/providers-claude.md`](docs/user/providers-claude.md). Anthropic's current product guidance
names Amazon Bedrock, Google's Agent Platform, and Microsoft Foundry as approved third-party
inference providers; it does not name OpenRouter. Although Claude Code supports configurable gateway
environment variables, promoting these specific configurations should be confirmed with Anthropic or
clearly described as an unsupported, user-managed configuration governed by the third-party
provider's terms.

#### 5. Competing-product language is ambiguous

Anthropic's Commercial Terms prohibit using its services to build a competing product, while its
more specific Claude Code guidance expressly permits hosted sandboxes and agent infrastructure. T3
is a multi-provider control surface rather than a competing model service, but it overlaps with
Claude's client experience. Written confirmation from Anthropic would remove this interpretive risk,
particularly for commercial distribution or marketing that positions T3 as an alternative to an
Anthropic client.

#### 6. Personal subscriptions should remain ordinary individual use

Anthropic states that advertised Free, Pro, and Max usage limits assume ordinary individual usage of
Claude Code and the Agent SDK. Shared, unattended, commercial, or high-volume automation should use
an organization-owned API or supported cloud-provider credential under the Commercial Terms.

## Recommended actions

1. Confirm and retain evidence that T3 Tools, Inc. has accepted Anthropic's Commercial Terms or has a
   separate written agreement covering the integration.
2. Document that personal subscription-backed providers are single-user, even when accessed from
   multiple devices, and must not be exposed to another human through pairing or T3 Connect.
3. For shared environments, require an organization-owned API or supported cloud credential and
   limit it to the owning organization's authorized users.
4. Remove the Claude logo from marketing and client surfaces unless T3 has written trademark
   permission. Keep accurate plain-text integration references and the allowed `Claude` agent label.
5. Ask Anthropic to confirm the OpenRouter/router documentation and T3's position as a multi-provider
   client rather than a competing service.
6. Continue avoiding any T3-managed Claude.ai OAuth flow or storage of Claude subscription tokens.
7. Re-review the integration when Anthropic changes its Claude Code legal guidance, Agent SDK terms,
   authentication rules, or branding requirements.

## Overall assessment

The implementation is intentionally built on the integration boundary Anthropic currently permits.
It is likely compliant for a single user operating their own unmodified Claude Code installation with
their own credentials. Full product compliance nevertheless depends on Commercial Terms acceptance,
one-credential-per-user operational controls, permitted branding, and clarification of the documented
third-party routing configurations.
