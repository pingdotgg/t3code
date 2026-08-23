# Grok Build

For first-time setup, see [Install T3 Code](./install.md). Install Grok Build, run `grok login`, then
enable Grok in Settings. You can set a custom binary path when `grok` is not on the server's normal
command path.

## Models And Reasoning

T3 Code asks Grok Build for its current model catalog during the provider status check. Models that
advertise reasoning choices show a Reasoning selector in the model picker. T3 Code sends the model
and reasoning choice together, so changing only the reasoning level also takes effect on the next
turn.

Reasoning changes and compatible model changes work in an existing thread. After the first turn,
models from a different Grok agent family require a new thread and are marked that way in the
picker. If another Grok Build client changes the same session, T3 Code follows the model and
reasoning level reported by Grok Build.

`Grok Build` is the compatibility fallback shown when model discovery is unavailable. Selecting it
keeps the CLI's current model instead of forcing a model named `grok-build`. Refresh provider status
after updating or signing in to Grok Build to load the current catalog and reasoning choices.

## Permissions

T3 Code still answers each ACP permission request according to the thread's permission setting. In
Full Access, it selects an advertised allow option automatically. In Approval Required, it shows the
request and waits for a decision.

## Usage, Titles, And Attachments

When Grok Build reports them, T3 Code can replace the default placeholder title and records
context-window usage, per-turn token totals, model usage, and trustworthy cost. Grok Build marks
incomplete or partial billing; T3 Code does not present those costs as final.

Image attachments are enabled only when the installed Grok Build agent advertises ACP image input.
Otherwise T3 Code rejects the attachment before sending the prompt.
