export function renderStatusAndContextSkill(): string {
  return `---
name: t3work-status-and-context-summary
description: "Summarize Jira ticket or project status from t3work context without surfacing internal workspace files. Use when the user asks for ticket status, ticket context, blockers, owner, child tickets, or linked repository impact. Prefer a read-only subagent for the exploration phase."
---

# T3work Status And Context Summary

Use this workflow when a user asks for the current state of a Jira ticket, project work item, linked repository context, or a similar t3work status question.

## Goals

- Answer in project language first.
- Keep internal workspace structure and cache file names out of the response unless the user explicitly asks for provenance.
- Separate evidence gathering from user explanation.

## Workflow

1. When the task is primarily lookup or synthesis, run a read-only Explore subagent.
2. Ask the subagent to inspect only the relevant t3work context, setup, and reference files needed to answer the question.
3. Ask the subagent to return:
   - the direct answer
   - the few supporting facts that matter
   - any ambiguity or stale-context warning
   - the internal sources checked, for agent use only
4. Reply to the user with:
   - current status first
   - owner, blocker, due signal, next step, or affected repository if available
   - one short caveat if the context may be stale or inconsistent

## Response Rules

- Do not narrate file exploration or quote internal paths in the main answer.
- Do not mention entrypoint.json, metadata.json, snapshot.json, or .t3work/... unless the user explicitly asks where the answer came from.
- If the context is stale or contradictory, say that directly instead of guessing.
- When the user asks for evidence, provide a short provenance note after the user-facing summary.

## Preferred Response Shape

- Status or outcome
- Why it matters or notable blocker
- Next useful follow-up

## Avoid

- "I checked entrypoint.json and metadata.json under .t3work/context/..."
- Step-by-step terminal narration unless the user asked for the investigation details
`;
}
