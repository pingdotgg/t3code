# Glossary

Shared vocabulary across Lathe. Architecture and lifecycle constraints belong in the
[architecture](./01_architecture.md).

## Workspace and conversation

| Term           | Meaning                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------- |
| Environment    | One running server and the machine, credentials, workspace access, and state it owns.             |
| Client         | A web, desktop, or mobile UI connected to an environment. The desktop app can also host a server. |
| Project        | An environment-local workspace record rooted at a directory.                                      |
| Workspace root | The project's base filesystem directory on the environment.                                       |
| Worktree       | A separate Git checkout a thread can use instead of the project's main checkout.                  |
| Thread         | The durable conversation and work history for a project. Survives provider process exits.         |
| Turn           | One user-to-agent cycle (a run). Provider work can end before checkpoint and diff work settles.   |
| Lathe home     | The base data directory. Runtime state normally lives under its `userdata` directory.             |

## Orchestration

| Term                    | Meaning                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| Command                 | A request to change domain state. Accepting it means intent committed, not that side effects finished.    |
| Event                   | A persisted fact produced by a command.                                                                   |
| Orchestrator            | The service that serializes commands and decides their events from current state, without I/O.            |
| Projection / read model | A persisted view of current state, committed in the same transaction as the events that change it.        |
| Command receipt         | A durable record of a command's result, used to make retries idempotent.                                  |
| Outbox effect           | Side-effect intent committed with the events, such as starting a provider turn or capturing a checkpoint. |
| Effect worker           | The worker that runs outbox effects after commit and feeds their results back as commands.                |

## Providers and checkpoints

| Term              | Meaning                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| Provider          | The agent runtime Lathe controls, such as Codex or Claude Code.                                              |
| Driver            | The integration for a provider kind.                                                                         |
| Provider instance | One configured provider, with its own settings and lifecycle. Multiple instances can use the same driver.    |
| Adapter           | The boundary translating a provider's native protocol into Lathe operations and events.                      |
| Session           | The provider runtime attached to a thread. A session can be stopped and resumed without deleting the thread. |
| Runtime mode      | The thread's permission policy. See [permission modes](../user/permission-modes.md).                         |
| Interaction mode  | How the agent approaches the task, such as planning. Separate from permission policy.                        |
| Checkpoint        | A saved workspace state used for diffs and restore, stored as a hidden Git ref.                              |

## Roadmap

| Term                | Meaning                                                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Roadmap             | The tree of planned work and its screen. One roadmap covers every environment.                                                            |
| Roadmap home        | The one environment whose database holds the roadmap. See [roadmap](./roadmap.md).                                                        |
| Work item           | A node in the roadmap tree. Never called a task, which delegated and scheduled tasks use, or an issue, which always means a GitHub issue. |
| Item type           | Objective, Key result, Initiative, Epic, Feature, Story, Bug, or Support ticket. The type limits which items can be its parent.           |
| Acceptance criteria | A work item's ordered checklist. Distinct from the provider goal.                                                                         |
| Area                | Work or Personal. An item without one inherits its parent's, and a root without one counts as Personal.                                   |
| Sprint              | A named date range in one area. Its items forecast from the area's last three finished sprints once there are three.                      |
| Velocity            | Units an area completes per working day, over the trailing 15 working days or its last three finished sprints.                            |
| Forecast            | A work item's projected finish date from its remaining units and its area's velocity: On track, At risk, or Late.                         |
| Capacity line       | Where Today stops counting rows: one day of work at the area's velocity. No line until the area has five completions.                     |
