# Welcome page

The Welcome page runs on a fresh local installation to help you verify an agent, optionally import existing projects and conversations, and connect the mobile app. Only one ready agent is required to start.

- Reopen it anytime from **Settings → About → Welcome page → Open**.
- Hosted `hyakki.ryoku.dev` skips this page and prompts you to sign in to Hyakki Connect and run `hyakki connect` on your computer instead.

## Agents

Hyakki lists detected agents first (ready ones on top), followed by **Add more agents** for all other supported providers:

- **Turn on**: Enables a disabled provider and checks its install and sign-in status.
- **Claude Code**: **Install** or **Sign in** opens a setup terminal using the vendor's installer (so **Update now** keeps working in Settings).
- **Codex**: **Set up** offers ChatGPT sign-in or your existing Codex CLI.
- **Outdated or other agents**: **Update** or selecting the agent opens its page in **Settings → Providers**. **Browse** opens the ACP Registry.
- **Desktop CLI**: Click **Add to PATH** if the `hyakki` command isn't yet on your shell `PATH`.

Click **Start** once at least one agent is ready, or **Start without an agent** to enter the app immediately (checked projects still import).

## Phone

Select **Set up** to scan the QR code for iOS or Android, then sign in to Hyakki Connect on both devices. If Hyakki Connect is unavailable or disabled by policy, pair with a code from **Settings → Sharing & access**.

## Projects and conversation import

Hyakki scans directories used by Claude Code, Codex, and Pi (turn on Pi under **Add more agents** to include Pi sessions).

- Git repositories active in the last 30 days with at least three conversations are pre-selected (excluding already-added projects, Codex scratch directories, and `Downloads`). Use **Review all** to customize the selection.
- Conversations active in the last 30 days are imported so you can continue them in Hyakki.

### Import limits

Conversation import is best-effort:

- Keeps the first user prompt and the most recent visible user/assistant messages (up to 200 messages total), omitting tool activity and attachments.
- Skips malformed/empty sessions, files over 4 GiB, sessions over 32 MiB of kept text/metadata, or sessions with over 100,000 records.
- Each import pass reads up to 100 conversations and 4 GiB per project. Reopen the Welcome page and select the project in **Review all** to continue importing a larger batch; already-imported conversations are skipped.
