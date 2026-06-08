# 2026 Multi-Agent Standard
# Teach this to Cursor once. Reference it in every future agent prompt.

---

## WHAT THIS IS

This is the 2026 Multi-Agent Standard — a communication and execution protocol
for running multiple AI agents in parallel inside a single codebase. When you
are told to spin up agents using this standard, follow every rule in this
document exactly.

Save this as a reference. Any future prompt that uses agents or words like "spin up an agent" or "follow the standard" should have you refer to this document.

---

## CORE CONCEPTS

### Agents
Each agent is a specialized role with a defined domain. Agents work in parallel
where possible and sequentially where there are dependencies. No agent works
outside their declared domain without posting a notice to the shared file first.

### Shared Communication File
All agents communicate through a single append-only markdown file at the repo
root. The file name is defined per-session (e.g. AGENT_SWARM.md, THINKTANK.md).
Agents read it before every phase. Agents write to it after every meaningful
action. It is the single source of truth for the session.

### Head Developer
The Head Developer is the orchestrator — the human or top-level agent running
the session. Agents escalate to HEAD_DEV when confidence is low, when there is
an unresolvable conflict, or when a change is irreversible.

---

## MESSAGE FORMAT

Every entry written to the shared file must use this exact structure.
No exceptions. Do not skip fields.

---
FROM: [CODENAME]
TO: [CODENAME | ALL | HEAD_DEV]
PHASE: [see phases below]
CONFIDENCE: [HIGH | MEDIUM | LOW]
REFS: [file:line, module name, or component this entry concerns]
---

[Body — findings, proposals, decisions, code snippets, questions, arguments]

OUTPUTS_DECLARED: [every file this agent intends to touch in this phase]
BLOCKING_ON: [agent codename I am waiting for, or NONE]
REVERSIBLE: [YES | NO | PARTIAL — if PARTIAL or NO, describe the rollback path]

---

## PHASES

Agents move through phases in order. Skipping a phase is not allowed.

AUDIT
  Read the codebase, existing state, and prior session files if any.
  Post findings. Do not make any changes yet.

DESIGN
  Post your plan. Declare every file you intend to touch in OUTPUTS_DECLARED.
  Wait for conflict resolution before proceeding.

IMPLEMENT
  Execute the plan. Only begin after DESIGN is posted and no conflicts are open.

VERIFY
  Review your own changes. Cross-review changes from agents you depend on.
  Post a VERIFY entry confirming the result or flagging a regression.

HANDOFF
  Post a final summary of everything done, measured results where available,
  and anything left unresolved for the next sprint.

BLOCKED
  Used any time an agent cannot proceed because it is waiting on another agent
  or on HEAD_DEV approval. Post what you are waiting for and why.

---

## CONFLICT RESOLUTION

If two agents declare the same file in OUTPUTS_DECLARED, both must stop and
resolve the conflict in the shared file before either proceeds.

Each session defines a tiebreaker authority per domain. The default is:
- Architecture and core files: the agent assigned to the core/kernel domain
- Everything else: HEAD_DEV

Tiebreaker authority is declared in the session prompt, not here.

---

## CONFIDENCE RULES

HIGH    — Agent has verified this against source code, documentation, or a
          test. Can proceed.

MEDIUM  — Agent has reasonable basis but has not fully verified. Can proceed
          but must flag the assumption in the message body.

LOW     — Agent is uncertain. Must escalate to HEAD_DEV. Do not implement
          anything rated LOW confidence without explicit approval.

---

## REVERSIBILITY RULES

REVERSIBLE: YES
  Change can be undone with a simple revert. Proceed normally.

REVERSIBLE: PARTIAL
  Some side effects are hard to undo (e.g. a database migration, a file format
  change). Describe the rollback path in the message. Proceed with caution.

REVERSIBLE: NO
  The change cannot be undone cleanly. This requires an explicit HEAD_DEV
  approval entry in the shared file before execution. Do not proceed without it.

---

## APPEND-ONLY RULE

No agent ever edits or deletes another agent's entries. The shared file is a
permanent record of the session. If an agent made an error in a prior entry,
they post a new entry correcting it — they do not edit the original.

---

## RE-READ RULE

Every agent must re-read the full shared file at the start of each new phase.
This catches messages addressed to them, resolved conflicts, and new decisions
made while they were working. Never begin a phase with stale context.

---

## IDLE RULE

An agent that finishes their phase before others is not done. They cross-review
another agent's work, post findings to the shared file, and flag any issues.
No agent goes idle while the session is active.

---

## PRIOR SESSION RULE

If a prior session file exists (e.g. AGENT_COMMS.md from Sprint 1), every agent
reads it before posting their first AUDIT entry. The prior file is an archive —
do not write to it. Use it to understand what was already done, what was left
unresolved, and what decisions were made so they are not relitigated.

---

## SESSION DELIVERABLE

Every session ends with a summary file produced by the agent assigned to output
or architecture. The file name is defined in the session prompt. It contains:

  - Every change made, by which agent
  - Before and after measurements where available
  - Anything deferred to the next sprint, explicitly marked
  - Any open questions that require HEAD_DEV decision

---

## EXECUTION ORDER TEMPLATE

Use this as the default execution order unless the session prompt overrides it.

Phase 1  —  All agents run AUDIT in parallel.
             Each posts an AUDIT entry before proceeding.

Phase 2  —  All agents post DESIGN entries.
             Agents cross-read each other's plans.
             Resolve all OUTPUTS_DECLARED conflicts before Phase 3.

Phase 3  —  IMPLEMENT.
             Dependency-free agents proceed immediately.
             Dependent agents wait for their BLOCKING_ON agent to post HANDOFF.

Phase 4  —  VERIFY.
             Each agent verifies their own work.
             Agents cross-verify work they depend on.

Phase 5  —  HANDOFF.
             All agents post final summaries.
             Designated agent produces the session deliverable file.

---

## HOW TO REFERENCE THIS IN A PROMPT

When writing a future agent prompt you do not need to redefine the schema.
Instead write:

  "Follow the 2026 Multi-Agent Standard."

And then only define what is session-specific:
  - Agent codenames and domains
  - Shared file name
  - Tiebreaker authority assignments
  - Session-specific phases or rules that override the defaults
  - The deliverable file name and format

Everything else is already defined here.

---

## QUICK REFERENCE CARD

  Message fields:    FROM / TO / PHASE / CONFIDENCE / REFS /
                     OUTPUTS_DECLARED / BLOCKING_ON / REVERSIBLE

  Phases in order:   AUDIT > DESIGN > IMPLEMENT > VERIFY > HANDOFF > BLOCKED

  Confidence gates:  LOW = escalate, do not implement
                     NO reversibility = HEAD_DEV approval required

  File rules:        Append only. Re-read before every phase. Archive prior sessions.

  Idle agents:       Cross-review, never stop working until session closes.
