# Mistral Vibe

T3 Code runs [Mistral Vibe](https://github.com/mistralai/mistral-vibe) as an agent through its ACP
server, `vibe-acp`, using your own Mistral account and Vibe configuration.

## Set Up Mistral Vibe

1. Install Vibe on the machine running the T3 Code server:
   `curl -LsSf https://mistral.ai/vibe/install.sh | bash`, or `uv tool install mistral-vibe`.
2. Run `vibe --setup` once in a terminal. You can instead set `MISTRAL_API_KEY` in the Mistral Vibe
   provider's **Mistral API key** field.
3. Open **Settings → Providers**, add **Mistral Vibe**, and enable it.

If `vibe-acp` is not on the server's `PATH`, set its **Binary path**. The installer usually puts it
in `~/.local/bin`.

## Models

The model picker lists the models Vibe offers once it is signed in. **Default** keeps the model
Vibe itself would start with. That model shows a **Thinking** setting with the levels Vibe offers
for it; other models run at Vibe's own thinking setting.

## Permission Modes

The permission mode picks the Vibe agent a thread runs as:

- **Supervised** runs Vibe's `ask` agent. Commands and file changes wait for your approval; reads
  and searches run without asking.
- **Auto-accept edits** runs `accept-edits`: Vibe applies file edits itself and asks before
  commands.
- **Full access** runs `auto-approve`, which runs every tool without asking.

Vibe offers no **Auto** mode in T3 Code.
