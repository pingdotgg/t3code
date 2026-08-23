# Antigravity

This guide covers setting up Antigravity in T3 Code. Antigravity connects to an Agent Client Protocol (ACP) server backend powered by Google's Gemini models (`gemini-3.7-flash`, `gemini-3.1-pro`).

## Requirements

- An Antigravity ACP server binary (`antigravity-acp-server`) available on your system `PATH`, or configured via a custom binary path in Settings.
- Authentication configured either via API key (`GEMINI_API_KEY` or `GOOGLE_API_KEY`) or via OAuth credentials.

## Enabling Antigravity

1. Open **Settings** → **Providers**.
2. Locate the **Antigravity** provider instance.
3. Toggle **Enabled** to on.
4. If your ACP server binary is installed in a custom location, set **Binary Path** accordingly.
5. Optionally configure **GEMINI_HOME** if using a custom configuration directory.

## Default Models

Antigravity defaults to **Gemini 3.7 Flash** (`gemini-3.7-flash`), offering high throughput and reasoning capabilities:

- `gemini-3.7-flash` (Default): Fast, versatile frontier multimodal model.
- `gemini-3.7-flash-high`: Flash with high reasoning effort.
- `gemini-3.7-flash-medium`: Flash with balanced reasoning effort.
- `gemini-3.7-flash-low`: Flash with low reasoning effort.
- `gemini-3.1-pro`: Advanced complex reasoning and coding model.

You can also specify additional model identifiers under **Custom models** in Settings.
