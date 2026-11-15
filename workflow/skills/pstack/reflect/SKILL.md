---
name: reflect
description: Spawn three parallel review subagents over the active transcript, surface learnings, and route each to a concrete edit on an existing skill. Use when the user says reflect.
---

# Reflect

Mine the current conversation for durable learnings, then route them into skill edits.

Invoke when the user says "reflect" or "/reflect". Skip when the conversation is trivial, off-topic, or already covered by an existing skill the parent followed correctly. One-offs are not learnings.

## 1. Locate the active transcript

The parent finds this session's own history before fanning out. It lives under `~/.claude/projects/<project-slug>/`, where the slug is the workspace path with the leading slash dropped and every remaining `/` turned into `-`. Use only that path. Do not glob across `~/.claude/projects/*/`. That crosses project boundaries and reads private chats from unrelated work.

```bash
ls -t ~/.claude/projects/<project-slug>/*.jsonl 2>/dev/null | head -10
```

That covers the legacy flat (`<id>.jsonl`), current nested (`<id>/<id>.jsonl`), and subagent (`<parent>/subagents/<child>.jsonl`) layouts. For each candidate, read the first JSONL line. Take the file whose `message.content[0].text` contains the conversation's opening user prompt. If none matches, pass a tight digest of the session instead.

## 2. Spawn three reviewers in parallel

One message, three `Agent` calls, `subagent_type: general-purpose`, explicit `model:` on each. Reviewers need MCP access for context lookups (tickets, chat threads, observability traces referenced in the history), so do not use a read-only agent type here. The prompt forbids file writes; the parent applies edits.

| Lens      | `model` | Prompt template                    |
| --------- | ------- | ---------------------------------- |
| Judgment  | `opus`  | `references/judgment-reviewer.md`  |
| Tooling   | `opus`  | `references/tooling-reviewer.md`   |
| Divergent | `fable` | `references/divergent-reviewer.md` |

Pass each template verbatim, substituting the transcript path or digest where marked. Reviewers return findings in the `Agent` response body.

## 3. Synthesize

One `Agent` call, `subagent_type: general-purpose`, `model: opus`. It spot-verifies citations through MCP, so do not use a read-only agent type here. Pass `references/synthesizer.md` verbatim, with each reviewer's full output inlined where marked. It returns an Accepted / Rejected / Backlog list.

## 4. Structural enforcement check

Move any Accepted item that a lint rule, script, metadata flag, or runtime check would enforce more reliably to Backlog. See the **encode-lessons-in-structure** principle skill.

## 5. Apply

Present the synthesizer's full Accepted / Rejected / Backlog output and wait for explicit approval before applying any Accepted edit. The user picks the subset and may redirect routings. Skill changes affect every future agent in the org. Do not auto-apply.

File each Backlog item to your team's devex or backlog tracker without waiting. Only the Accepted list waits for approval.

Never edit a skill under `plugins/cache/`. Before approval, show its destination, `.claude/skills/<skill>/` or `~/.claude/skills/<skill>/`. After approval, copy the skill folder there and edit the copy. Never open a PR or push.

Follow each approved row's Routing exactly:

- Trivial existing-skill edit (a one-line bullet, a tightened sentence, a stale fact corrected): parent does directly.
- Substantive existing-skill edit (a new section, a new pattern table, more than ~10 lines): hand to the **writing-for-agents** skill and run its draft / revise loop.
- `tune description: <skill path>` (the skill exists but didn't trigger when it should have): hand to **writing-for-agents** and rework the description until it triggers on the missed case.
- `new skill: <kebab-name>`: hand creation to **writing-for-agents**. Do not invent the shape ad hoc.

If your environment ships a SKILL.md validator, run it on every touched skill before declaring done.

## 6. Summarize for the user

Short list, no preamble:

- Edits applied: `<skill path>`. What changed, one line each.
- New skills created: `<skill path>`. One line each (rare).
- Backlog filed to the devex tracker: `<issue title>` (`<tags>`). One line each.
- Dropped: one line per rejected finding + reason from the synthesizer.
