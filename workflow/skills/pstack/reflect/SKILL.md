---
name: reflect
description: Spawn three parallel review subagents over the active transcript, surface learnings, and route each to a concrete edit on an existing skill. Use when the user says reflect.
---

# Reflect

Mine the current conversation for durable learnings, then route them into skill edits.

Invoke when the user says "reflect" or "/reflect". Skip when the conversation is trivial, off-topic, or already covered by an existing skill the parent followed correctly. One-offs are not learnings.

## 1. Locate the active transcript

The parent finds this session's own thread before fanning out, through T3 Code's thread tools, which cover every provider. Search the active project with `t3_thread_search` for the conversation's opening user prompt, or list its newest threads with `t3_thread_list`. Read each candidate's first message with `t3_thread_read` (`afterPosition: -1`) and take the thread whose first message is the opening user prompt. Stay in the active project, as in `recall` step 2. If no thread matches, pass a tight digest of the session instead.

## 2. Spawn three reviewers in parallel

Delegate to three subagents at once (in T3 Code: three `delegate_task` calls), each on the model the table names. Reviewers need MCP access for context lookups (tickets, chat threads, observability traces referenced in the history), so give them a general agent, not a read-only one. The prompt forbids file writes; the parent applies edits.

| Lens | Model | Prompt template |
|---|---|---|
| Judgment | your strongest | `references/judgment-reviewer.md` |
| Tooling | your strongest | `references/tooling-reviewer.md` |
| Divergent | a different strong model, ideally another provider's | `references/divergent-reviewer.md` |

Pass each template verbatim, substituting the thread id or digest where marked. Reviewers return findings in their final reply.

## 3. Synthesize

Delegate to one subagent on your strongest model. It spot-verifies citations through MCP, so give it a general agent, not a read-only one. Pass `references/synthesizer.md` verbatim, with each reviewer's full output inlined where marked. It returns an Accepted / Rejected / Backlog list.

## 4. Structural enforcement check

Move any Accepted item that a lint rule, script, metadata flag, or runtime check would enforce more reliably to Backlog. See the **encode-lessons-in-structure** principle (`~/.agents/skills/principle-encode-lessons-in-structure/SKILL.md`).

## 5. Apply

Present the synthesizer's full Accepted / Rejected / Backlog output and wait for explicit approval before applying any Accepted edit. The user picks the subset and may redirect routings. Skill changes affect every future agent in the org. Do not auto-apply.

File each Backlog item to your team's devex or backlog tracker without waiting. Only the Accepted list waits for approval.

Never edit a skill through an installed copy: a provider's skill folder, a plugin cache, or a symlink. Edit the source in this repo. An existing workflow skill lives at `workflow/skills/<group>/<skill>/`, and a new skill goes in `workflow/skills/ak/<skill>/`, with a folder name no other group uses. An edit to a vendored group (`mattpocock`, `pstack`) also gets a line in that group's `ATTRIBUTION.md`. Before approval, show each destination. After applying the edits, run `vp run workflow:link` so every provider sees new or removed skills. Never open a PR or push.

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
