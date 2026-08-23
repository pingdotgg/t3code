# Antigravity (Google Gemini)

This guide covers setting up and using Google's Antigravity CLI (`agy`) as a provider in T3 Code.

## Prerequisites

1. Install the official Antigravity CLI:
   - **macOS / Linux**:
     ```bash
     curl -fsSL https://antigravity.google/cli/install.sh | bash
     ```
   - **Windows (PowerShell)**:
     ```powershell
     irm https://antigravity.google/cli/install.ps1 | iex
     ```
2. Log in with your Google account:
   ```bash
   agy
   ```
   Follow the interactive authentication prompt in your browser or terminal to cache your credentials.

## Provider Configuration in T3 Code

In T3 Code Settings -> **Providers** -> **Antigravity**:

- **Enabled**: Check to enable Antigravity.
- **Binary path**: Defaults to `agy` (or an absolute path if installed in a custom location, e.g. `~/.local/bin/agy`).
- **Dangerously Skip Permissions**: Enabled by default to allow headless/unattended tool execution during turns.

## Supported Models

Antigravity includes built-in access to Gemini and partner models:

- `gemini-3.7-flash-high` (Default - Gemini 3.7 Flash with High reasoning)
- `gemini-3.7-flash-medium` (Gemini 3.7 Flash with Medium reasoning)
- `gemini-3.7-flash-low` (Gemini 3.7 Flash with Low reasoning)
- `gemini-3.6-flash-high` (Gemini 3.6 Flash with High reasoning)
- `gemini-3.6-flash-medium` (Gemini 3.6 Flash with Medium reasoning)
- `gemini-3.6-flash-low` (Gemini 3.6 Flash with Low reasoning)
- `gemini-3.5-flash-high` (Gemini 3.5 Flash with High reasoning)
- `gemini-3.5-flash-medium` (Gemini 3.5 Flash with Medium reasoning)
- `gemini-3.5-flash-low` (Gemini 3.5 Flash with Low reasoning)
- `gemini-3.1-pro-high` (Gemini 3.1 Pro with High reasoning)
- `gemini-3.1-pro-low` (Gemini 3.1 Pro with Low reasoning)
- `claude-sonnet-4-6` (Claude Sonnet 4.6 Thinking)
- `claude-opus-4-6-thinking` (Claude Opus 4.6 Thinking)
- `gpt-oss-120b-medium` (GPT-OSS 120B Medium)

### Reasoning Effort

For models that support reasoning configuration, you can adjust the **Reasoning Effort** in the chat composer:

- `low`
- `medium`
- `high` (Default)
