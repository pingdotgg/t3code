# Antigravity

This guide is for using the Google Antigravity agent CLI (`agy`) with T3 Code.

## Prerequisites

1. Install Antigravity CLI:
   Make sure `agy` is installed and accessible in your shell `PATH`.
2. Authenticate:
   Run `agy login` or configure your environment credentials.
3. Test your installation:
   ```bash
   agy --version
   ```

## Enable Antigravity in T3 Code

Antigravity is opt-in by default. To enable it:

1. Open **Settings** in T3 Code.
2. Navigate to **Providers** -> **Antigravity**.
3. Toggle **Enabled** to ON.
4. If your `agy` executable is located in a custom path, specify the full executable path in **Binary path**.

## Supported Models

T3 Code surfaces all models available in Antigravity:

- **Gemini 3.7 Flash** (`gemini-3.7-flash-high`, `gemini-3.7-flash-medium`, `gemini-3.7-flash-low`)
- **Gemini 3.6 Flash** (`gemini-3.6-flash-high`, `gemini-3.6-flash-medium`, `gemini-3.6-flash-low`)
- **Gemini 3.5 Flash** (`gemini-3.5-flash-high`, `gemini-3.5-flash-medium`, `gemini-3.5-flash-low`)
- **Gemini 3.1 Pro** (`gemini-3.1-pro-high`, `gemini-3.1-pro-low`)
- **Claude Sonnet 4.6 (Thinking)** (`claude-sonnet-4-6`)
- **Claude Opus 4.6 (Thinking)** (`claude-opus-4-6-thinking`)
- **GPT-OSS 120B (Medium)** (`gpt-oss-120b-medium`)

## Skills & Slash Commands

T3 Code automatically discovers your Antigravity skills from:

- `~/.gemini/antigravity-cli/skills` and `~/.gemini/antigravity-cli/builtin/skills`
- `~/.agents/skills`
- Workspace `.agents/skills` and `.gemini/skills`

Type `$` in the composer to pick from discovered skills.
