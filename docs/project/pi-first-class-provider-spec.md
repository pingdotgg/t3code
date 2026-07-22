## Problem Statement

T3 Code users who prefer Pi cannot use it as a first-class coding-agent provider alongside Codex, Claude, OpenCode, Cursor, and Grok. They lose T3 Code's project/thread workflow, model picker, chat and work-log visibility, provider-instance management, and safe session continuation while also needing to preserve Pi's own provider configuration, custom providers, extensions, native session format, and tool behavior.

## Solution

Add Pi as a first-class `pi` provider driver for Pi CLI `0.81.1` or later. T3 Code will launch the user-installed `pi` executable in RPC mode and adapt its JSONL protocol into the existing provider lifecycle. Pi remains the source of truth for credentials, custom providers, models, extensions, and enabled-tool policy. T3 Code manages Pi runtime instances, native-session routing, thread lifecycle, presentation, diagnostics, and recovery.

## User Stories

1. As a T3 Code user, I want Pi to appear as an available provider, so that I can use Pi without leaving T3 Code.
2. As a Pi user, I want T3 Code to run my installed Pi CLI rather than a bundled replacement, so that my Pi version, authentication, configuration, and extensions remain mine.
3. As a user, I want to add multiple Pi runtime instances, so that I can keep independent Pi environments separate.
4. As a user, I want each Pi runtime instance to have a display name and accent color, so that I can distinguish it in provider and model pickers.
5. As a user, I want to choose a Pi executable path, so that T3 Code can use a non-default or managed Pi installation.
6. As a user, I want an empty Pi config-directory setting to use my normal Pi configuration, so that the default setup is frictionless.
7. As a user, I want to set a Pi config directory per runtime instance, so that I can use separate Pi credentials, providers, models, and extensions when needed.
8. As a user, I want T3 Code to pass the selected config directory through `PI_AGENT_DIR`, so that Pi itself remains responsible for resolving its configuration.
9. As a user, I want generic per-instance environment variables, so that Pi and its configured providers can receive the environment they require.
10. As a Pi user, I want Pi to remain the source of truth for credentials, custom providers, and models, so that I do not have to duplicate configuration in T3 Code.
11. As a user, I want T3 Code to discover the configured Pi model catalog, so that custom Pi models appear automatically.
12. As a user, I want Pi models grouped by their Pi provider in the normal T3 model picker, so that I can select the intended provider/model combination.
13. As a user, I want model changes to use Pi's native model-selection RPC operation, so that Pi owns the effective model state.
14. As a user, I want only supported thinking levels to be selectable for the current Pi model, so that I cannot request an invalid reasoning mode.
15. As a user, I want a new T3 Code thread using Pi to create a persisted native Pi session, so that the conversation is resumable by Pi.
16. As a user, I want each T3 Code thread ID to map to a stable Pi session ID, so that restarts do not create duplicate or ambiguous Pi sessions.
17. As a user, I want Pi sessions stored in a directory isolated to their Pi runtime instance, so that separate configurations do not accidentally share session storage.
18. As a user, I want to understand where Pi sessions are stored, so that I can access them with Pi when necessary.
19. As a user, I want Pi threads to continue only with the Pi runtime instance that created them, so that the original configuration, credentials, extensions, model catalog, and session storage are preserved.
20. As a user, I want text responses to stream in T3 Code, so that Pi feels like the other first-class providers.
21. As a user, I want Pi thinking streams to appear in the normal T3 Code experience, so that I can understand active reasoning where Pi provides it.
22. As a user, I want Pi tool calls, live execution progress, output, and results to appear in the work log, so that I can observe what Pi is doing.
23. As a user, I want retries, context compaction, and queued work to appear in the normal work log, so that known Pi lifecycle activity is not hidden or treated as unsupported.
24. As a user, I want image attachments sent through T3 Code to reach Pi, so that I can use Pi's native image prompting.
25. As a user, I want to interrupt an active Pi turn, so that I can stop unwanted work.
26. As a user, I want an unexpected Pi process or connection loss to mark the active turn interrupted rather than replay it, so that T3 Code never duplicates tool calls.
27. As a user, I want to continue a thread after a process or connection loss, so that T3 Code relaunches Pi against the persisted native session.
28. As a Pi user, I want my trusted global and project-local Pi extensions to load normally, so that T3 Code does not disable my established Pi workflow.
29. As a user, I want basic Pi extension dialogs such as confirmation, selection, and text input to appear in T3 Code when Pi exposes them through RPC, so that compatible extensions remain usable.
30. As a user, I want unsupported custom extension terminal UI to be identified clearly, so that I know when an interaction requires Pi's terminal interface.
31. As a user, I want T3 Code not to install, edit, or configure my Pi extensions, so that extension ownership and trust stay with Pi.
32. As a user, I want Pi's configured enabled-tool policy to remain effective, so that T3 Code does not silently change which Pi tools are available.
33. As a user, I want Pi tool access clearly labelled as Pi-managed, so that I understand enabled tools run without T3 Code's normal per-tool approval prompt.
34. As a user, I want no misleading T3 runtime-mode selector for Pi, so that T3 Code does not imply it can supervise Pi tools when it cannot.
35. As a user, I want advanced launch arguments where safe, so that I can use legitimate Pi options without sacrificing T3 Code session correctness.
36. As a user, I want T3 Code to reserve Pi RPC mode, session directory, and session ID arguments, so that settings cannot break native-session routing or recovery.
37. As a user, I want an actionable warning when Pi is missing, unavailable, or older than `0.81.1`, so that I can resolve compatibility issues before starting a thread.
38. As a user, I want native Pi protocol events retained in diagnostics, so that provider and extension failures can be investigated without guessing.
39. As a maintainer, I want the Pi integration to use the existing provider-driver architecture, so that it participates in the same registry, health, status, maintenance, session, and orchestration flows as other providers.
40. As a maintainer, I want the initial implementation to have explicit deferrals, so that unsupported Pi-specific interactions can be revisited deliberately after the core adapter is stable.

## Implementation Decisions

- Add a built-in `pi` Provider Driver Kind and a first-class Pi Provider driver registered with the existing driver registry.
- Require Pi CLI `0.81.1` or later. The provider status probe must inspect the selected executable, report its version, and present a clear unavailable or upgrade-required state when the executable is missing, invalid, or too old.
- The driver launches the user-selected `pi` executable as a scoped child process using Pi RPC mode and JSONL stdin/stdout framing. It must use a strict LF-delimited JSONL parser rather than a generic line reader.
- Use Pi RPC as the integration boundary; do not import Pi's Node package into the T3 Code server process and do not reconstruct Pi behavior from session files.
- Add per-instance Pi settings for: enabled state, binary path (default `pi`), optional Pi config directory, optional additional launch arguments, and UI-only custom model preferences where the existing provider settings model requires them. Existing generic instance display name, accent color, and environment remain available.
- When a Pi config directory is configured, pass it as `PI_AGENT_DIR`; otherwise allow Pi to use its normal user configuration. Pi configuration remains authoritative for credentials, external/custom providers, configured models, enabled tools, and extensions.
- Support multiple Pi Runtime Instances from the first release. Each instance has independently resolved executable/configuration environment and an isolated Pi Session Directory.
- T3 Code controls the required Pi launch parameters: RPC mode, the per-instance session directory, and the stable thread-derived Pi session ID. Validate additional launch arguments and reject attempts to override those parameters.
- Map every T3 Code thread to a native persisted Pi session. Use the T3 Code thread ID as the Pi session ID and scope the session directory to the Pi Runtime Instance.
- Bind Pi Continuation Compatibility to the originating Pi Runtime Instance. Continuation must not switch into a Pi instance with another configuration environment or session directory.
- On session/process/connection loss, mark an active Pi turn interrupted and close the live session. Do not replay the active prompt automatically. A later explicit continuation restarts Pi using the stored native session and originating runtime-instance configuration.
- Probe each Pi Runtime Instance through RPC for its configured model catalog. Convert available Pi models into the existing server model snapshot/picker representation, preserving provider grouping.
- Map model selection to Pi `set_model` and use Pi's available-thinking-level RPC data to drive the existing model-option system. Do not invent unsupported thinking options.
- Map supported Pi RPC events comprehensively into existing provider events and orchestration projections: session lifecycle, turn lifecycle, streamed text, streamed thinking, tool-call construction, tool-execution start/update/end, tool results/errors, agent settled, retries, compaction, and queued-work changes.
- Render the mapped events with existing normal chat/work-log capabilities wherever semantics match. Retain native Pi event payloads in diagnostics/native event logs.
- Translate image attachments from T3 Code's attachment representation to Pi RPC image prompt content.
- Implement stop/interrupt with Pi's native abort RPC command.
- Preserve normal trusted Pi global and project-local extension loading. T3 Code must not install, mutate, enable, disable, or otherwise configure extensions.
- Support basic extension UI RPC requests for confirm, select, and input through the existing request/response UX contract. If Pi emits custom terminal UI that has no faithful T3 representation, show a clear terminal-required notice rather than silently discarding it.
- Pi Tool Policy is Pi-managed for the initial release. T3 Code must not expose its normal runtime-mode selector for Pi and must clearly communicate that every tool enabled by Pi may run without a T3 per-tool confirmation.
- Align Pi availability, snapshots, status refresh, maintenance/update advice, provider selection, settings, diagnostics, and icons with existing built-in provider conventions.
- Respect the Pi domain language and the existing ADR sequence covering the integration boundary, session isolation, configuration ownership, multi-instance support, tool policy, extension behavior, config-directory selection, model discovery, lifecycle mapping, recovery, continuation compatibility, managed launch parameters, and version baseline.

## Testing Decisions

- Use one high-level provider-adapter contract seam: a controlled/fake Pi RPC transport is driven through the Pi provider adapter, provider service, and orchestration ingestion pipeline; tests assert externally observable T3 Code behavior rather than adapter-private calls or data structures.
- Prefer the existing provider adapter, provider registry, provider status, and provider-runtime-ingestion test patterns as prior art. Reuse their harness style for fake runtime streams, scoped child process lifecycle, model snapshots, session bindings, and turn/activity projections.
- Add focused contract tests for provider registration, default and multiple Pi Runtime Instances, configuration-directory propagation, isolated session directories, managed launch-argument validation, status/version outcomes, and thread-to-native-session identity.
- Add focused model tests covering discovery of custom Pi providers/models, grouping/labels, model selection, valid thinking-level options, and rejection or surfacing of invalid Pi model operations.
- Add focused runtime-event tests that feed Pi RPC events and assert visible chat/work-log state for text, thinking, tool calls, tool progress, tool results, retry, compaction, queued work, terminal errors, and settled/completed/interrupted turns.
- Add focused attachment and abort tests asserting Pi receives image prompts and that a stop request reaches native abort behavior.
- Add focused extension tests for normal extension preservation, basic confirm/select/input request round trips, and visible terminal-required treatment for unsupported custom UI.
- Add focused safety/recovery tests proving enabled Pi tools are described as Pi-managed, no T3 runtime-mode selector is shown for Pi, a process/transport loss interrupts rather than replays an active turn, and explicit continuation resumes the same native session only through the originating Pi Runtime Instance.
- Add focused settings/UI tests for Pi instance creation/editing, binary/config-directory/launch-argument fields, validation of reserved arguments, provider icon/picker visibility, and model-picker behavior.
- Run the smallest affected server/contracts/web test sets. After the user-visible web flow is integrated, perform the required isolated web verification using the repository's T3 app testing workflow and stop its temporary dev server afterward.

## Out of Scope

- Building a new Pi API client or importing Pi's internal Node runtime into T3 Code.
- Duplicating Pi credential, provider, custom-provider, model, extension, or enabled-tool configuration inside T3 Code.
- Automatic migration or browsing of sessions from Pi's default global session directory.
- Allowing a Pi thread to continue under another Pi Runtime Instance.
- Silently replaying in-flight turns after process or transport loss.
- A T3 Code runtime-mode selector or built-in supervised per-tool permission flow for Pi.
- Installing, editing, enabling, disabling, or otherwise managing user Pi extensions.
- Faithfully rendering arbitrary custom Pi terminal widgets in T3 Code.
- Pi-specific session export, fork, rollback, browsing, or management controls in T3 Code.
- Pi extension-command UI and custom extension interactions beyond basic RPC dialogs.
- Pi-specific steering/follow-up controls beyond the normal T3 interaction model, unless a clean equivalent is implemented later.
- Support for Pi versions older than `0.81.1`.

## Further Notes

- This specification is based on Pi CLI `0.81.1` and its documented RPC, model, session, extension UI, and tool-policy behavior.
- The initial integration is intentionally comprehensive for all Pi behavior that has a known, semantically faithful T3 Code mapping. Items are deferred only where a safe equivalent does not exist, not merely to reduce implementation scope.
- Pi has no built-in permission system that restricts filesystem, process, network, or credential access. Users who need stronger boundaries must use Pi's own tool configuration, extensions, or external sandbox/container controls. A future supervised T3 experience would require T3 Code to inject and maintain a Pi permission-gate extension over Pi's extension UI RPC protocol.
- The implementation must preserve backwards-compatible provider instance and thread persistence behavior while adding the `pi` driver.
