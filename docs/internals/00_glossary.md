# Glossary

Shared vocabulary across T3 Code. Architecture and lifecycle constraints belong in the
[architecture](./01_architecture.md).

## Workspace and conversation

| Term           | Meaning                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| Environment    | One running server and the machine, credentials, workspace access, and state it owns.                |
| Client         | A web, desktop, or mobile UI connected to an environment. The desktop app can also host a server.    |
| Project        | An environment-local workspace record rooted at a directory.                                         |
| Workspace root | The project's base filesystem directory on the environment.                                          |
| Worktree       | A separate Git checkout a thread can use instead of the project's main checkout.                     |
| Thread         | The durable conversation and work history for a project. Survives provider process exits.            |
| Turn           | One user-to-agent cycle (a run). Provider work can end before checkpoint and diff work settles.      |
| T3 home        | The base data directory. Runtime state normally lives under its `userdata` directory.                |
| Read state     | When a thread was last open on any client, held as `lastVisitedAt`. Viewing never moves `updatedAt`. |

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

| Term              | Meaning                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------- |
| Provider          | The agent runtime T3 Code controls, such as Codex or Claude Code.                                               |
| Driver            | The integration for a provider kind.                                                                            |
| Provider instance | One configured provider, with its own settings and lifecycle. Multiple instances can use the same driver.       |
| Adapter           | The boundary translating a provider's native protocol into T3 Code operations and events.                       |
| Session           | The provider runtime attached to a thread. A session can be stopped and resumed without deleting the thread.    |
| Runtime mode      | The thread's permission policy. See [permission modes](../user/permission-modes.md).                            |
| Interaction mode  | How the agent approaches the task, such as planning. Separate from permission policy.                           |
| Checkpoint        | A saved workspace state used for diffs and restore, stored as a hidden Git ref.                                 |
| Subagent model    | The model a thread's subagents run on, held as `subagentModelSelection`. Null means inherit the thread's model. |

## Voice input

| Term             | Meaning                                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Speech model     | What turns a recording into text on the device: the system recognizer or a downloaded Parakeet model, gated on device memory. |
| Stand-in         | The system recognizer taking a recording the chosen model could not: not downloaded, still loading, or failed.                |
| Diarization      | Splitting a recording into stretches of speech attributed to different speakers.                                              |
| Voice profile    | The voiceprint made from the user's enrollment samples. Stored on the device only.                                            |
| Voice filter     | Diarization plus the voice profile, used to cut other speakers' turns before transcription. Keeps everything when unsure.     |
| Replacement rule | A heard and written pair applied to every transcript. Written by the user or learned from corrections made before sending.    |

See [voice input](./voice-input.md).
