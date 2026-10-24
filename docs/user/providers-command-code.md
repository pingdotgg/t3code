# Command Code

T3 Code can run your existing Command Code (`command-code`) coding agent installation while keeping Command Code's models, authentication, Taste profiles, skills, and ACP capabilities.

## Set Up Command Code

1. Install [Command Code](https://commandcode.ai) on the machine running the T3 Code server:
   ```sh
   npm install -g command-code
   ```
2. Run `cmd login` in a terminal to authenticate your account or connect your model providers.
3. In T3 Code, open **Settings → Providers**, enable **Command Code**, and refresh the provider.

If `cmd` is not on the server's `PATH`, set Command Code's binary path to the executable in the provider settings.

Update an npm-installed Command Code with `npm install -g command-code` or by running `cmd update`.

## How It Works

T3 Code connects to Command Code using its native Agent Client Protocol server (`cmd acp`). The connection communicates over stdio using JSON-RPC, running directly on the host server.

- **Models and Thought Levels**: T3 Code discovers models advertised by Command Code (including frontier models like GPT-5.6 Sol and local models via Ollama / vLLM) and maps reasoning effort to T3 Code's thought-level controls.
- **Taste Engine**: Project-specific and user-level taste profiles (`.commandcode/taste/taste.md`) are respected by Command Code during session turns.
- **Plan and Build Modes**: Command Code's native plan mode integrates directly with T3 Code's Plan toggle in the composer.
- **Permission Modes**:
  - **Supervised**: Asks for approval before running file edits and shell commands.
  - **Auto-accept edits**: Automatically permits file modifications while prompting for command executions.
  - **Auto**: Evaluates actions through Command Code's permission filters.
  - **Full access**: Runs tools autonomously without approval prompts.

## Troubleshooting

- If Command Code shows as missing or uninstalled, verify that `cmd` is accessible in the terminal environment where T3 Code server runs (`which cmd`).
- To test the ACP server manually, run `cmd acp` in a shell; it should wait quietly on stdin for JSON-RPC messages without exiting immediately.
- If models fail to load or sign-in errors occur, run `cmd login` or check your API keys configured in `cmd`.
