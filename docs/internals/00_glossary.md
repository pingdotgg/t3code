# Glossary

Shared vocabulary across T3 Code. Architecture and lifecycle constraints belong in the
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
| T3 home        | The base data directory. Runtime state normally lives under its `userdata` directory.             |

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
| Provider          | The agent runtime T3 Code controls, such as Codex or Claude Code.                                            |
| Driver            | The integration for a provider kind.                                                                         |
| Provider instance | One configured provider, with its own settings and lifecycle. Multiple instances can use the same driver.    |
| Adapter           | The boundary translating a provider's native protocol into T3 Code operations and events.                    |
| Session           | The provider runtime attached to a thread. A session can be stopped and resumed without deleting the thread. |
| Runtime mode      | The thread's permission policy. See [permission modes](../user/permission-modes.md).                         |
| Interaction mode  | How the agent approaches the task, such as planning. Separate from permission policy.                        |
| Checkpoint        | A saved workspace state used for diffs and restore, stored as a hidden Git ref.                              |
