# Workflows

A workflow is a script that ties agents, plain code, schedules, webhooks and questions to you into
one run that survives restarts. Each step's result is stored: a restart continues the run where it
was, and a step that fails pauses the run until it is resumed, instead of losing the work before
it. Workflows are an early feature: you start them from the `t3` command and follow them in
Settings.

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

## Follow runs in the app

Once a server has workflow runs, a **Workflows** button appears at the bottom of the sidebar. A
number on it says how many runs wait on you: a question to answer, or a run paused by a failing
step.

The page lists runs under **Needs you**, **Running** and **All**, and can narrow to one workflow.
Select a run to read it from top to bottom: each agent with what it said and returned, questions
where they were asked, and the quick steps between them folded into a line. A run another run
invoked is opened from that run. From a run you can answer its question, resume it when it is
paused, or cancel it. **Transcript** on an agent opens its thread beside the run, where you can
read its work and talk to it before you answer. Answering, resuming and cancelling need a
connection that may operate threads.

An agent's thread does not appear in the thread list. Open it from its run; the thread itself
links back to the run.

An agent step can run on another machine: give it the id of a
[linked environment](remote-access.md#link-another-environment) and a project there. The run itself stays on the
server that started it.

Workflows can keep state between runs, such as a switch or a cursor. `t3 workflow store list`
shows it, and `t3 workflow store set <key> '<json>'` changes it.

## Webhooks

`t3 workflow hooks` prints a URL path for each webhook a workflow listens on. Add your server's
address in front of it, the same one a scheduled task's webhook uses. The path contains the hook's
secret, so share it only with the sender. An organization policy that blocks webhook tasks blocks
these too.
