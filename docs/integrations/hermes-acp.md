# Hermes in Code (ACP)

Hermes in Code is a first-class ACP provider session family. It launches
`hermes acp` as a JSON-RPC stdio child process through T3 Code's existing ACP
runtime.

It is intentionally separate from the Hermes Work integration:

- `hermesAcp` / **Hermes in Code** uses the Agent Client Protocol over stdio.
- `hermes` / Hermes Work uses the authenticated `hermes serve` websocket
  gateway.

The gateway is not treated as ACP and is not used as a fallback for this
provider.

## Required Hermes capability

The configured executable must support both commands:

```text
hermes acp --version
hermes acp --check
```

T3 Code reports the provider ready only when the ACP entrypoint exists and its
adapter dependency check succeeds. Session startup then negotiates the actual
ACP capabilities exposed by that Hermes build.

The pinned Hermes revision used by the Hermes conformance work,
`2c1a38a3cc4b5727c817f007a46c377cafddde4c`, contains the genuine
`acp_adapter` stdio server and advertises session load, resume, list, fork,
model switching, cancellation, image prompts, permissions, and authentication.

T3 Code passes its session-scoped MCP endpoint through ACP session setup and
sets `HERMES_ACP_SKIP_CONFIGURED_MCP=1` for the child process. This avoids
silently importing unrelated global Hermes MCP configuration into the
supervised provider session.

## Configuration

Add a provider instance with driver **Hermes in Code**. The only required
setting is the path to the Hermes executable; it defaults to `hermes` on
`PATH`. Provider credentials and the selected default model remain owned by
Hermes. Additional model IDs can be added through the provider's model
settings.
