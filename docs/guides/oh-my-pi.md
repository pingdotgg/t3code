# Oh My Pi provider

T3 Code can use [Oh My Pi](https://github.com/can1357/oh-my-pi) as an external ACP coding harness. T3 owns the provider lifecycle; OMP remains authoritative for its own roles, model routing, fallbacks, reasoning settings, subagents, tools, MCP, permissions, and context handling.

## Setup

1. Install `omp` on the machine running the T3 server.
2. Authenticate/configure OMP normally so its credentials and model configuration are available under the normal OMP configuration directory (`~/.omp`).
3. In T3 Code, open **Settings → Connections**, add an **Oh My Pi** provider instance, and optionally set a custom binary path if `omp` is not on the server's `PATH`.
4. Select **Oh My Pi (managed)** when starting a thread.

T3 starts `omp acp` on demand. You do not need to pre-start an OMP collaboration or ACP process in a terminal. Remote clients, including the normal Android app, use the same provider through the running T3 server.

## Ownership boundary

T3 deliberately exposes OMP as one synthetic model named **Oh My Pi (managed)**. That selection means “use the OMP harness”; it is not an underlying LLM selection. T3 does not call ACP model- or mode-selection methods for this provider.

OMP therefore remains responsible for `DEFAULT`, `SMOL`, `SLOW`, `PLAN`, `VISION`, `DESIGNER`, `COMMIT`, `TINY`, `TASK`, `ADVISOR`, and any future OMP roles or routing policy.

## ACP behavior

The provider launches:

```text
omp acp
```

Current OMP ACP advertises the authentication method id `agent`, which reuses the credentials already configured in OMP. T3 uses that method; the older `api_key` and `cached_token` ids are not used.

The integration uses standard T3 ACP plumbing for session creation/resume, streamed assistant content, tool-call updates, permission approvals, cancellation, MCP injection, and image prompt blocks.

## Current limitations

- T3 does not surface or modify OMP's ACP `mode`, `model`, or `thinking` config options. This is intentional so OMP stays authoritative.
- T3 does not currently expose OMP ACP form elicitations as T3 structured user-input requests. OMP is started without advertising that optional client capability.
- The minimal attachment bridge currently maps T3 attachments to ACP image blocks. Non-image file/resource attachment mapping is not added here.
- Provider-side thread rollback is not exposed.
- Resume uses the OMP ACP session id stored in T3's normal provider resume cursor. If OMP cannot resume a particular stored session, T3 surfaces the ACP failure rather than emulating a session.

## Maintenance design

The provider is implemented as an ordinary T3 `ProviderDriver` plus ACP adapter/support files. Shared orchestration, database schemas, thread formats, mobile protocols, and native role routing are unchanged. The ACP spawn/runtime portion is intentionally small enough to migrate later to a generic external-ACP provider factory.
