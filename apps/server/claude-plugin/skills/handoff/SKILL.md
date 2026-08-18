---
name: handoff
description: Hand off work from this T3 Code thread to a fresh one. Use when the user asks to hand off, continue in a new thread/session, or spin the remaining work out into a follow-up. Composes a name and summary of the work so far and asks T3 Code to create, seed, and start the new thread.
---

# Handoff

You are running inside a thread managed by T3 Code. A **handoff** transfers work to
a brand-new thread in the same project: you write the new thread's name and a
summary of the work so far, and T3 Code creates the thread, seeds it with your
summary as its first user message, and starts it immediately. The current
thread is left untouched; both threads record the lineage.

The user may give a focus — what the *next* session is for (e.g. "hand off
the remaining test failures"). Tailor everything to that focus. Without one,
hand off the natural continuation of the current work.

## Compose the handoff

**Name** (a few words): what the new thread is about — it becomes the thread's
title. Name the destination, not the origin ("Fix flaky auth tests", not
"Continuation of session").

**Summary** (the new thread's first user message — its agent starts cold with
nothing else):

- State the goal of the new thread first, then the context needed to pursue it.
- Reference, don't duplicate: point at files, commits, branches, and docs by
  path/hash instead of pasting their contents.
- Include what was already tried and ruled out, current state (what's done,
  what's broken, what's untested), and the concrete next steps.
- If specific skills, commands, or docs helped in this session, add a short
  "Suggested skills/tools" section naming them.
- Never include secrets, tokens, or credentials — reference where they live
  instead.
- Write it as instructions to a capable colleague, not as a transcript.

## Run the handoff

Send the summary on stdin (heredoc) to the T3 Code CLI — `$T3_CLI` when set,
otherwise `t3`. Keep the quotes around `"${T3_CLI:-t3}"` exactly as written:

```bash
"${T3_CLI:-t3}" handoff --name "<the name>" <<'HANDOFF_SUMMARY'
<the summary>
HANDOFF_SUMMARY
```

The command prints the new thread's title, id, and URL. Relay them to the
user as confirmation, e.g. "Handed off to **<name>** — <url>". If the command
fails, report its error output; do not retry with made-up credentials or
fabricate a confirmation.
