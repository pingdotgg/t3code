# Goals

T3-owned completion contracts on a Thread. A Goal is not a provider slash command and not a scheduled loop.

## Language

**Goal**:
A Thread-scoped completion contract owned by T3. A Thread has at most one Goal; a new Objective replaces it. While it is active, T3 starts the next Turn without a new user message until the Goal is complete, paused, blocked, or usage-limited. Provider CLIs are not the source of truth and must not be asked to start their own Goal.
_Avoid_: Loop, sticky reminder, prompt, slash command, backlog, Codex goal, native goal

**Objective**:
The user-written outcome a Goal is contracted to achieve. When `/goal` starts work on an idle Thread, the Objective is also the user message of that first Turn, without the `/goal` prefix. The English word “goal” is allowed here. Command forms (`/goal`, “slash goal”) never go to a provider; every composer intercepts them and the server refuses a Turn whose user text is still a command form.
_Avoid_: prompt, instruction, slash command

**Active**:
A Goal state that permits auto-continue. If the Thread is idle when a Goal becomes active, T3 starts a Turn immediately. If a Turn is already running, T3 waits until that Turn ends. Becoming Active sets the Thread’s interaction mode to default; a Goal does not run in plan mode.
_Avoid_: running, in progress

**Thread**:
The durable conversation and work history a Goal belongs to. A Goal is not attached to a Session, a Project, or a Provider.
_Avoid_: Session, chat, conversation

**Pause**:
A Goal state that forbids auto-continue. Stop during a Goal Turn pauses the Goal. Resume is required before T3 may start the next Turn. Settle, Snooze, and a closed client do not Pause.
_Avoid_: Snooze, settle, clear, cancel

**Resume**:
Returning a paused Goal to active so T3 may start the next Turn.
_Avoid_: Unsnooze, restart, unsettle, continue

**Complete**:
A Goal state meaning the objective is satisfied. Only a structured complete signal from a Turn, or an explicit user action, may enter this state. Chat prose cannot complete a Goal.
_Avoid_: done, finished, success

**Clear**:
Removing the Goal from the Thread. Clear abandons the contract; it does not mean the objective was met.
_Avoid_: Complete, delete, cancel

**Blocked**:
A Goal state meaning the work cannot make progress. Auto-continue stops. The model may enter it via a structured signal; T3 may enter it when Continuations produce no progress. Resume tries again. Pause is the user stopping the Goal; Blocked is the work stopping it.
_Avoid_: Pause, error, failed, stuck

**Usage-limited**:
A Goal state meaning the provider account cannot accept more work right now. Auto-continue stops. v1 has no user-set token budget; quota and rate-limit failures enter this state, not Blocked. Resume tries again.
_Avoid_: over budget, budget-limited, rate-limited

**Continuation**:
A Turn T3 starts because a Goal is Active. It has no user message. An Activity may record that the Goal continued; the assistant output is the visible work.
_Avoid_: follow-up, keep-going prompt, synthetic user message
