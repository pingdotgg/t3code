# Welcome wizard

T3 Code shows a setup flow when you open a new installation or connect to the
hosted app for the first time. Existing workspaces skip this flow.

## Choose a connection

- **This computer** runs agents on the computer that hosts T3 Code. It does not
  require an account.
- **T3 Connect** connects computers that are signed in to your account. Run
  `npx t3 connect` on each computer you want to add.
- **Pair a server** connects directly to a server on your network or tailnet.
  Run `npx t3 pair` on the server, then paste the pairing link.

## Check your agents

T3 Code checks the selected computer for Claude Code, Codex, and Cursor. If an
agent is not installed or signed in, select its action to open a terminal with
the correct command ready to run. Other providers are available in Settings.

## Import your projects

T3 Code finds directories that Claude Code or Codex has used. The default
selection includes projects active within the last 30 days. Select **Choose**
to include older projects or change the selection.

You can skip agent setup and project import. Select **Back** to return to a
previous step.
