# Welcome Wizard

On a fresh install, T3 Code opens a short setup flow before the main app.
Installs with existing projects or completed onboarding skip it.

## Choose how to connect

- **Local Only** — agents run on this machine. No account needed. Shown on the
  desktop app and locally served web app.
- **T3 Connect** — sign in and reach any of your machines from anywhere.
  Machines signed into your account connect automatically. If none are
  connected yet, the wizard shows the command to run on the machine with your
  code (`npx t3 connect`) and advances when it appears.
- **Direct** — connect to a server by URL. Works over LAN and Tailscale. Run
  `npx t3 pair` on the server and paste the pairing URL it prints.

## Set up your agents

The wizard checks the connected machine for Claude Code and Codex and shows
their install and sign-in status. If one is missing, an inline terminal opens
with the install command pre-typed — press Enter to run it. It's a real shell,
so you can run the CLI's sign-in there too, or use the card's **Sign in**
action after the install finishes. Other supported agents are configured in
Settings → Providers.

## Import your projects

T3 Code scans the connected machine for directories where Claude Code or Codex
have already run and offers them as projects. The default imports projects
active in the last 30 days; **Choose** lists everything found. Imports create
projects only — thread history import is coming later.

Every step after the connection choice can be skipped. Projects can always be
added later from the command palette.
