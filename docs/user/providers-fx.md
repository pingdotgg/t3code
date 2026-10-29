# fx

T3 Code can run [fx](https://fx.sh). fx uses the login on the machine that runs the T3 Code server.

## Set up fx

1. Install fx on that machine:

   ```bash
   curl -fsSL https://fx.sh/setup.sh | bash
   ```

2. Run `fx login` in a terminal on that machine.
3. Open **Settings → Providers**, enable fx, and refresh the provider.

If `fx` is not on the server's `PATH`, set **Binary path** to the executable.

Every fx instance on the same machine shares that machine's fx login. T3 Code does not keep a separate login per instance.

## Backends, models, and effort

fx can run models through several backends: Vercel AI Gateway, a Codex subscription, a Grok subscription, and any OpenAI-compatible endpoint you configure in fx's settings. In the model picker, the fx tab lists each backend under its own heading. Open a backend to see the models it offers, then pick one. Search lists every backend's models together.

The backend is part of each thread's model choice, so two threads can run on different backends at the same time. Switching it in T3 Code changes only that thread's fx session. It never changes the default `fx provider` sets for your terminal.

Sign-ins are different: every fx instance on a machine shares that machine's fx login. A backend you are signed out of shows as unavailable, with the command to run on that machine, such as `fx login grok`. Refresh the provider after signing in.

**Default** runs whatever fx would start a new session on in the thread's project folder, including a model fx's settings give only that folder. Its label shows the machine-wide default. A custom model you add in the provider settings goes to fx as is, on the thread's current backend, and fx reports an error if that backend does not offer it.

fx also has an **Effort** control. A new thread starts at Medium.

Type `$` in the composer to list the skills fx finds in its skill folders, in the order fx's own skill menu shows them. When two different skills share a name, the menu lists the one fx loads for that name: the first copy in fx's folder order, starting with the workspace. The menu shows one skill per name regardless of case; to run a skill whose name differs only in case, such as `Review` next to `review`, type its exact name.

## Permission modes

fx offers two composer modes.

| Mode           | Behavior                                                                            |
| -------------- | ----------------------------------------------------------------------------------- |
| **Supervised** | fx asks before it changes files or runs commands. Read requests run without asking. |
| **Auto**       | fx handles routine actions itself. Anything it still asks about reaches you.        |

T3 Code does not offer **Full access** or **Auto-accept edits** for fx. A thread already set to one of those runs in **Supervised**. Changing the permission mode restarts the connection and reloads the same fx session.

On fx versions after [vercel-labs/fx#1189](https://github.com/vercel-labs/fx/pull/1189), fx saves the mode T3 Code sets as its default permission mode. T3 Code sets it each time it opens an fx thread, so fx in the terminal then starts in that thread's mode.

A message steered into a running turn stops that turn, and fx answers the new message in the same session.

## Sub-agents

When fx hands work to a sub-agent, it opens in its own thread under the parent. That thread shows the sub-agent's task and its reply, which fx shortens to a couple of lines. fx doesn't share the sub-agent's individual steps.

fx doesn't pass on a sub-agent's permission requests, so a sub-agent that needs one waits until you press **Stop**. This mostly happens in **Supervised**. In **Auto**, sub-agents can finish routine work by themselves.

## Not supported yet

- Plan mode.
- **Full access**.
- **Auto-accept edits**.
- Commit messages, pull request text, branch names, and thread titles. Pick another provider for those.

See [provider setup](./install.md#providers) and [Permission modes](./permission-modes.md).
