# Devin

Devin runs locally on your environment through its CLI. Install [Devin CLI](https://docs.devin.ai/cli), run `devin auth login` on the machine running T3 Code, then enable **Devin** in **Settings → Providers**.

If `devin` launches Devin Desktop, set **Binary path** to the actual CLI executable. The Desktop launcher does not support ACP.

Available models load from `devin models list --format json` when provider status refreshes, before you start a chat. Refresh **Settings → Providers** after changing your Devin subscription. Choose a model family, then set its thinking level and, where available, Fast mode or context window. Workspace commands load when the session opens.

Select a model from your account's catalog. Saved threads resume their Devin session, and model changes apply within the same thread. A temporary refresh failure keeps the last available model list; signing out clears it.

T3 forwards permission requests and supports Plan mode, cancellation, images, file attachments, and `/compact`. Auto mode uses Devin's Smart mode when available and asks for approval otherwise. Conversation rewind is not supported by Devin ACP.

Type `$` in the composer to select a skill discovered by Devin CLI for your workspace. T3 invokes the selected skill with the rest of your message as its arguments. Devin supports one explicit skill invocation per message; native `/skill-name` commands work too. Skills can use T3's browser and device tools when those capabilities are available on your connected environment.

For remote connections, installation and sign-in happen on the server machine. Provider instances can use separate environments, including `WINDSURF_API_KEY` for API-key authentication.

If the CLI is signed in in your terminal but T3 reports **Not authenticated**, compare the environment variables used by each. On Linux and macOS, Devin stores credentials under `$XDG_DATA_HOME/devin` when set, otherwise `~/.local/share/devin`; on Windows it uses `%APPDATA%\devin`. See [Devin's credential locations](https://docs.devin.ai/cli/enterprise/devin-auth#credentials-file-location).

Use the same credential directory in the provider instance's **Environment variables**, or run `devin auth login` with that instance's environment, then refresh provider status. Custom launchers should isolate T3 with `T3CODE_HOME` without redirecting `XDG_DATA_HOME` for provider processes.

For generated titles and source-control text, choose another provider under **Settings → General → Text generation model**.
