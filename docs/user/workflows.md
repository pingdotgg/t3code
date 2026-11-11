# Workflows

A workflow is a script that ties agents, plain code, schedules, webhooks and questions to you into
one run that survives restarts. Each step's result is stored: a restart continues the run where it
was, and a step that fails pauses the run until it is resumed, instead of losing the work before
it. Workflows are an early feature with no screen of their own yet; you run them from the `t3`
command.

For one prompt on a timer or from a webhook, use a scheduled task. Reach for a workflow when the
work has stages, such as triage, then a fix, then your approval, then a release.

## Turn workflows on

1. Write a definitions file. The [`t3-workflows` skill](../../skills/t3-workflows/SKILL.md)
   describes the format with a full example. Copy that folder into your agent's skills directory
   (for example `~/.claude/skills/` or `~/.agents/skills/`) and ask the agent to write the workflow
   for you.
2. Start the server with `T3CODE_WORKFLOWS` set to the file's absolute path.
3. Restart the server after you change the file.

Runs live on the machine that started them and only make progress while its server is running. For
a schedule that must not be missed, run the server on a machine that stays on.

## Run and steer

```sh
t3 workflow start <name> --input '<json>' --key <key>
t3 workflow list
t3 workflow show <run>
t3 workflow resume <run>
t3 workflow cancel <run>
t3 workflow questions
t3 workflow signal '{"choice":"yes"}' --run <run> --wait <question>
t3 workflow hooks
```

Starting twice with the same key gives the same run, so a script that retries does not start a
second one. A paused run names the step that failed and why; fix the cause and resume it, and only
that step runs again.

Each agent step works in an ordinary thread. Open it to read what the agent did or to help it.

## Webhooks

`t3 workflow hooks` prints a URL path for each webhook a workflow listens on. Add your server's
address in front of it, the same one a scheduled task's webhook uses. The path contains the hook's
secret, so share it only with the sender. An organization policy that blocks webhook tasks blocks
these too.
