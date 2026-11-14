import * as NodeOS from "node:os";

import { CODEX_THREAD_CONFIG } from "../src/orchestration-v2/Adapters/CodexAdapterV2.ts";
import { revertCodexThread } from "../src/provider/CodexThreadRevert.ts";
import { buildCodexInitializeParams } from "../src/provider/CodexProvider.ts";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as CodexClient from "effect-codex-app-server/client";
import type * as CodexSchema from "effect-codex-app-server/schema";

import {
  MESSAGE_STEERING_INITIAL_PROMPT,
  MESSAGE_STEERING_STEER_PROMPT,
  MULTI_TURN_FIRST_PROMPT,
  MULTI_TURN_SECOND_PROMPT,
  PLAN_QUESTIONS_PROMPT,
  PROPOSED_PLAN_PROMPT,
  PROVIDER_THREAD_RESUME_FIRST_PROMPT,
  PROVIDER_THREAD_RESUME_SECOND_PROMPT,
  SIMPLE_PROMPT,
  SUBAGENT_CONTINUE_PARENT_PROMPT,
  SUBAGENT_CONTINUE_PROMPT,
  SUBAGENT_PROMPT,
  SUBAGENT_V2_APPROVAL_PROMPT,
  SUBAGENT_V2_PROMPT,
  SUBAGENT_V2_NESTED_APPROVAL_PROMPT,
  SUBAGENT_V2_NESTED_PROMPT,
  THREAD_ROLLBACK_AFTER_PROMPT,
  THREAD_ROLLBACK_FIRST_PROMPT,
  THREAD_ROLLBACK_SECOND_PROMPT,
  THREAD_MERGE_BACK_SIBLINGS_FIRST_FORK_PROMPT,
  THREAD_MERGE_BACK_SIBLINGS_FIRST_HANDOFF_PROMPT,
  THREAD_MERGE_BACK_SIBLINGS_RECALL_PROMPT,
  THREAD_MERGE_BACK_SIBLINGS_SECOND_FORK_PROMPT,
  THREAD_MERGE_BACK_SIBLINGS_SECOND_HANDOFF_PROMPT,
  THREAD_MERGE_BACK_SIBLINGS_SOURCE_PROMPT,
  TODO_LIST_PROMPT,
  TOOL_CALL_WRITE_PROMPT,
  TURN_INTERRUPT_MID_TOOL_PROMPT,
  COMMAND_OUTPUT_STREAMING_PROMPT,
  TURN_INTERRUPT_PROMPT,
  WEB_SEARCH_PROMPT,
} from "../src/orchestration-v2/testkit/fixtures/shared.ts";
import { codexReplayRecordingOutputRecords } from "./codexReplayRecordingRecords.ts";
import { makeReplayRecorderDeferredRegistry } from "./replayRecorderDeferredRegistry.ts";
import type { ReplayScenario } from "./record-codex-app-server-replay-fixture.ts";
import { granularApprovalPolicy, readOnlyFullAccessSandbox, readOnlyRestrictedSandbox, workspaceWriteSandbox } from "./record-codex-app-server-replay-fixture.ts";

export function scenarios(): ReadonlyArray<ReplayScenario> {
  return [
    {
      name: "simple",
      fileName: "simple.ndjson",
      description: "One thread and one turn with a deterministic text-only response.",
      runs: [
        {
          name: "simple",
          description: "Single text-only turn.",
          prompt: SIMPLE_PROMPT,
          steps: [{ type: "turn", label: "simple", prompt: SIMPLE_PROMPT }],
        },
      ],
    },
    {
      name: "tool_call_read_only_on_request",
      fileName: "tool_call_read_only_on_request.ndjson",
      description:
        "Write a small fixture file with read-only full filesystem visibility and on-request approvals.",
      // gpt-6-luna declines to attempt the write under a read-only sandbox; gpt-6-sol tries it.
      model: "gpt-6-sol",
      runs: [
        {
          name: "read-only-on-request",
          description:
            "Write action under read-only full filesystem visibility with on-request approvals.",
          prompt: TOOL_CALL_WRITE_PROMPT,
          turnDefaults: {
            approvalPolicy: "on-request",
            sandboxPolicy: readOnlyFullAccessSandbox(),
          },
          steps: [{ type: "turn", label: "write-fixture-file", prompt: TOOL_CALL_WRITE_PROMPT }],
        },
      ],
    },
    {
      name: "tool_call_workspace_never",
      fileName: "tool_call_workspace_never.ndjson",
      description:
        "Write a small fixture file with workspace-write sandbox policy and never approvals.",
      runs: [
        {
          name: "workspace-never",
          description:
            "Write action under workspace-write policy with never approvals for baseline no-prompt behavior.",
          prompt: TOOL_CALL_WRITE_PROMPT,
          turnDefaults: {
            approvalPolicy: "never",
            sandboxPolicy: workspaceWriteSandbox(),
          },
          steps: [{ type: "turn", label: "write-fixture-file", prompt: TOOL_CALL_WRITE_PROMPT }],
        },
      ],
    },
    {
      name: "tool_call_restricted_granular",
      fileName: "tool_call_restricted_granular.ndjson",
      description:
        "Write a small fixture file with restricted read access and granular approval flags enabled.",
      // gpt-5.6-terra uses apply_patch, which raises this approval; gpt-6 uses the shell.
      model: "gpt-5.6-terra",
      runs: [
        {
          name: "restricted-granular",
          description:
            "Write action under restricted read access with granular approval flags enabled, intended to capture permission request flows when Codex escalates.",
          prompt: TOOL_CALL_WRITE_PROMPT,
          turnDefaults: {
            approvalPolicy: granularApprovalPolicy(),
            sandboxPolicy: readOnlyRestrictedSandbox(),
          },
          steps: [
            {
              type: "turn",
              label: "write-fixture-file",
              prompt: TOOL_CALL_WRITE_PROMPT,
            },
          ],
        },
      ],
    },
    {
      name: "subagent",
      fileName: "subagent.ndjson",
      description: "One root turn that asks Codex to spawn two collab agents.",
      // gpt-5.6-luna still runs multi-agent v1, the only live source of collabAgentToolCall.
      model: "gpt-5.6-luna",
      runs: [
        {
          name: "two-subagents",
          description: "Root turn asks for two subagents reading different files.",
          prompt: SUBAGENT_PROMPT,
          // Without this, children read the recording user's own skills into the fixture.
          threadConfig: { "skills.include_instructions": false },
          turnDefaults: {
            approvalPolicy: "on-request",
            sandboxPolicy: readOnlyFullAccessSandbox(),
          },
          steps: [{ type: "turn", label: "spawn-two-subagents", prompt: SUBAGENT_PROMPT }],
        },
      ],
    },
    {
      name: "subagent_v2",
      fileName: "subagent_v2.ndjson",
      description:
        "One root turn on a multi-agent v2 model that spawns one native subagent and waits for it.",
      runs: [
        {
          name: "spawn-v2-subagent",
          description:
            "The default model runs multi-agent v2, so Codex emits subAgentActivity items.",
          steps: [{ type: "turn", label: "spawn-v2-subagent", prompt: SUBAGENT_V2_PROMPT }],
        },
      ],
    },
    {
      name: "subagent_v2_approval",
      fileName: "subagent_v2_approval.ndjson",
      description:
        "One root turn in approval-required mode whose multi-agent v2 subagent runs a command that needs approval.",
      runs: [
        {
          name: "spawn-v2-subagent-needing-approval",
          description:
            "The child inherits the root's approval policy, so its write asks the client for approval on the child's native thread and turn.",
          turnDefaults: {
            approvalPolicy: "untrusted",
            sandboxPolicy: { type: "readOnly" },
          },
          steps: [
            {
              type: "turn",
              label: "spawn-v2-subagent-needing-approval",
              prompt: SUBAGENT_V2_APPROVAL_PROMPT,
            },
          ],
        },
      ],
    },
    {
      name: "subagent_v2_nested",
      fileName: "subagent_v2_nested.ndjson",
      description:
        "One root turn on a multi-agent v2 model whose subagent spawns a subagent that spawns a leaf.",
      runs: [
        {
          name: "spawn-nested-v2-subagents",
          description: "Multi-agent v2; depth 3 lets each child spawn again.",
          threadConfig: { "agents.max_depth": 3 },
          steps: [
            {
              type: "turn",
              label: "spawn-nested-v2-subagents",
              prompt: SUBAGENT_V2_NESTED_PROMPT,
            },
          ],
        },
      ],
    },
    {
      name: "subagent_v2_nested_approval",
      fileName: "subagent_v2_nested_approval.ndjson",
      description:
        "One root turn in approval-required mode whose multi-agent v2 subagent spawns a subagent that runs a command that needs approval.",
      runs: [
        {
          name: "spawn-nested-v2-subagent-needing-approval",
          description:
            "Depth 2 lets the first child spawn once. The grandchild inherits the root's approval policy, so its write asks the client for approval on the grandchild's native thread and turn.",
          threadConfig: { "agents.max_depth": 2 },
          turnDefaults: {
            approvalPolicy: "untrusted",
            sandboxPolicy: { type: "readOnly" },
          },
          steps: [
            {
              type: "turn",
              label: "spawn-nested-v2-subagent-needing-approval",
              prompt: SUBAGENT_V2_NESTED_APPROVAL_PROMPT,
            },
          ],
        },
      ],
    },
    {
      name: "subagent_continue",
      fileName: "subagent_continue.ndjson",
      description:
        "A root turn spawns one native Codex subagent, then a later root turn resumes and messages the same child thread.",
      // gpt-5.6-luna still runs multi-agent v1, the only live source of collabAgentToolCall.
      model: "gpt-5.6-luna",
      runs: [
        {
          name: "continued-subagent",
          description:
            "The second root turn asks Codex to continue the subagent created by the first root turn.",
          steps: [
            {
              type: "turn",
              label: "spawn-subagent",
              prompt: SUBAGENT_CONTINUE_PROMPT,
            },
            {
              type: "turn",
              label: "continue-subagent",
              prompt: SUBAGENT_CONTINUE_PARENT_PROMPT,
            },
          ],
        },
      ],
    },
    {
      name: "multi_turn",
      fileName: "multi_turn.ndjson",
      description: "One thread with two sequential user turns.",
      runs: [
        {
          name: "two-turns-same-thread",
          description: "Second turn starts after the first root turn completes.",
          steps: [
            {
              type: "turn",
              label: "first",
              prompt: MULTI_TURN_FIRST_PROMPT,
            },
            {
              type: "turn",
              label: "second",
              prompt: MULTI_TURN_SECOND_PROMPT,
            },
          ],
        },
      ],
    },
    {
      name: "queued_turn",
      fileName: "queued_turn.ndjson",
      description: "A second user turn queued behind an active turn starts after it completes.",
      runs: [
        {
          name: "queued-second-turn",
          description:
            "The orchestrator holds the queued message until the first turn completes, so the provider sees two sequential turns.",
          steps: [
            { type: "turn", label: "first", prompt: MULTI_TURN_FIRST_PROMPT },
            { type: "turn", label: "queued", prompt: MULTI_TURN_SECOND_PROMPT },
          ],
        },
      ],
    },
    {
      name: "provider_thread_resume",
      fileName: "provider_thread_resume.ndjson",
      description:
        "One provider-native thread is started, completed, then resumed by thread id in a fresh app-server session.",
      runs: [
        {
          name: "resume-provider-thread",
          description:
            "First turn completes, the app-server runtime is restarted, thread/resume loads the existing provider thread, then a second turn completes.",
          steps: [
            {
              type: "turn",
              label: "first-before-resume",
              prompt: PROVIDER_THREAD_RESUME_FIRST_PROMPT,
            },
            {
              type: "turn",
              label: "second-after-resume",
              prompt: PROVIDER_THREAD_RESUME_SECOND_PROMPT,
            },
          ],
        },
      ],
    },
    {
      name: "todo_list",
      fileName: "todo_list.ndjson",
      description: "One turn that asks Codex to emit progress through update_plan.",
      runs: [
        {
          name: "todo-list",
          description: "Default-mode turn that should surface turn/plan/updated notifications.",
          prompt: TODO_LIST_PROMPT,
          turnDefaults: {
            approvalPolicy: "never",
            sandboxPolicy: readOnlyFullAccessSandbox(),
          },
          steps: [{ type: "turn", label: "todo-list", prompt: TODO_LIST_PROMPT }],
        },
      ],
    },
    {
      name: "web_search",
      fileName: "web_search.ndjson",
      description:
        "One turn with a native Codex webSearch item that should become normalized progress.",
      runs: [
        {
          name: "web-search",
          description: "Default-mode turn that should surface a webSearch item.",
          steps: [{ type: "turn", label: "web-search", prompt: WEB_SEARCH_PROMPT }],
        },
      ],
    },
    {
      name: "plan_questions",
      fileName: "plan_questions.ndjson",
      description: "One plan-mode turn that asks a structured clarifying question.",
      runs: [
        {
          name: "plan-questions",
          description: "Plan-mode turn intended to surface item/tool/requestUserInput.",
          prompt: PLAN_QUESTIONS_PROMPT,
          interactionMode: "plan",
          turnDefaults: {
            approvalPolicy: "never",
            sandboxPolicy: readOnlyFullAccessSandbox(),
          },
          steps: [{ type: "turn", label: "plan-questions", prompt: PLAN_QUESTIONS_PROMPT }],
        },
      ],
    },
    {
      name: "proposed_plan",
      fileName: "proposed_plan.ndjson",
      description: "One plan-mode turn that emits a proposed plan document.",
      runs: [
        {
          name: "proposed-plan",
          description:
            "Plan-mode turn intended to surface item/plan/delta and completed plan item.",
          prompt: PROPOSED_PLAN_PROMPT,
          interactionMode: "plan",
          turnDefaults: {
            approvalPolicy: "never",
            sandboxPolicy: readOnlyFullAccessSandbox(),
          },
          steps: [{ type: "turn", label: "proposed-plan", prompt: PROPOSED_PLAN_PROMPT }],
        },
      ],
    },
    {
      name: "message_steering",
      fileName: "message_steering.ndjson",
      description: "One active turn receives an immediate turn/steer request.",
      runs: [
        {
          name: "immediate-steer",
          description: "Start a turn, then immediately steer the active root turn.",
          steps: [
            {
              type: "steeredTurn",
              label: "steered",
              prompt: MESSAGE_STEERING_INITIAL_PROMPT,
              steer: MESSAGE_STEERING_STEER_PROMPT,
            },
          ],
        },
      ],
    },
    {
      name: "turn_interrupt",
      fileName: "turn_interrupt.ndjson",
      description: "One active turn is interrupted before it finishes naturally.",
      runs: [
        {
          name: "interrupt-active-turn",
          description: "Start a long-running turn, then send turn/interrupt.",
          prompt: TURN_INTERRUPT_PROMPT,
          turnDefaults: {
            approvalPolicy: "never",
            sandboxPolicy: workspaceWriteSandbox(),
          },
          steps: [
            {
              type: "interruptedTurn",
              label: "interrupt-active-turn",
              prompt: TURN_INTERRUPT_PROMPT,
              interruptAfterMs: 1_500,
            },
          ],
        },
      ],
    },
    {
      name: "turn_interrupt_mid_tool",
      fileName: "turn_interrupt_mid_tool.ndjson",
      description:
        "One active turn is interrupted after Codex has already executed a local command.",
      runs: [
        {
          name: "interrupt-after-command-execution",
          description: "Start a turn, wait for command execution, then send turn/interrupt.",
          prompt: TURN_INTERRUPT_MID_TOOL_PROMPT,
          turnDefaults: {
            approvalPolicy: "never",
            sandboxPolicy: workspaceWriteSandbox(),
          },
          steps: [
            {
              type: "interruptedTurn",
              label: "interrupt-after-command-execution",
              prompt: TURN_INTERRUPT_MID_TOOL_PROMPT,
              interruptAfterCommandExecutionStarted: true,
            },
          ],
        },
      ],
    },
    {
      name: "command_output_streaming",
      fileName: "command_output_streaming.ndjson",
      description: "One command prints over several seconds, so Codex streams its output deltas.",
      runs: [
        {
          name: "command-output-streaming",
          description: "Run a foreground command that prints a line a second.",
          prompt: COMMAND_OUTPUT_STREAMING_PROMPT,
          turnDefaults: {
            approvalPolicy: "never",
            sandboxPolicy: workspaceWriteSandbox(),
          },
          steps: [
            {
              type: "turn",
              label: "command-output-streaming",
              prompt: COMMAND_OUTPUT_STREAMING_PROMPT,
            },
          ],
        },
      ],
    },
    {
      name: "thread_rollback",
      fileName: "thread_rollback.ndjson",
      description:
        "One thread completes two turns, rolls back the most recent turn, then starts another turn.",
      runs: [
        {
          name: "rollback-one-turn",
          description:
            "Two completed turns, thread/revert before the second turn, then a post-rollback turn.",
          steps: [
            {
              type: "turn",
              label: "first-before-rollback",
              prompt: THREAD_ROLLBACK_FIRST_PROMPT,
            },
            {
              type: "turn",
              label: "second-before-rollback",
              prompt: THREAD_ROLLBACK_SECOND_PROMPT,
            },
            {
              type: "rollback",
              label: "rollback-latest-turn",
              numTurns: 1,
            },
            {
              type: "turn",
              label: "post-rollback",
              prompt: THREAD_ROLLBACK_AFTER_PROMPT,
            },
          ],
        },
      ],
    },
    {
      name: "thread_rollback_after_restart",
      fileName: "thread_rollback_after_restart.ndjson",
      description:
        "One thread completes two turns, the app-server restarts, then the thread rolls back its latest turn and starts another turn.",
      runs: [
        {
          name: "rollback-after-restart",
          description:
            "Two completed turns, a fresh app-server that has not loaded the thread, thread/revert before the second turn, then a post-rollback turn.",
          steps: [
            {
              type: "turn",
              label: "first-before-rollback",
              prompt: THREAD_ROLLBACK_FIRST_PROMPT,
            },
            {
              type: "turn",
              label: "second-before-rollback",
              prompt: THREAD_ROLLBACK_SECOND_PROMPT,
            },
            {
              type: "rollback",
              label: "rollback-latest-turn",
              numTurns: 1,
            },
            {
              type: "turn",
              label: "post-rollback",
              prompt: THREAD_ROLLBACK_AFTER_PROMPT,
            },
          ],
        },
      ],
    },
    {
      name: "thread_rollback_to_stopped_turn",
      fileName: "thread_rollback_to_stopped_turn.ndjson",
      description:
        "One completed turn, one turn stopped mid-tool, one completed turn, thread/revert back to the stopped turn, then a post-rollback turn.",
      runs: [
        {
          name: "rollback-to-stopped-turn",
          description:
            "Edit the message after a stopped turn: revert the turn after it and keep the stopped turn.",
          turnDefaults: {
            approvalPolicy: "never",
            sandboxPolicy: workspaceWriteSandbox(),
          },
          steps: [
            {
              type: "turn",
              label: "first-before-rollback",
              prompt: THREAD_ROLLBACK_FIRST_PROMPT,
            },
            {
              type: "interruptedTurn",
              label: "stopped-mid-tool",
              prompt: TURN_INTERRUPT_MID_TOOL_PROMPT,
              interruptAfterCommandExecutionStarted: true,
            },
            {
              type: "turn",
              label: "second-before-rollback",
              prompt: THREAD_ROLLBACK_SECOND_PROMPT,
            },
            {
              type: "rollback",
              label: "rollback-to-stopped-turn",
              numTurns: 1,
            },
            {
              type: "turn",
              label: "post-rollback",
              prompt: THREAD_ROLLBACK_AFTER_PROMPT,
            },
          ],
        },
      ],
    },
    {
      name: "thread_merge_back_siblings",
      fileName: "thread_merge_back_siblings.ndjson",
      description:
        "Two sibling fork deltas are merged sequentially into one source provider thread and recalled together.",
      // gpt-6-luna often recalls acknowledgements; gpt-6-sol recalls the markers.
      model: "gpt-6-sol",
      runs: [
        {
          name: "merge-native-sibling-forks",
          description:
            "Proves repeated merge-back handoffs accumulate on the source while native sibling forks remain independent.",
          steps: [
            {
              type: "turn",
              label: "source",
              prompt: THREAD_MERGE_BACK_SIBLINGS_SOURCE_PROMPT,
              thread: "source",
            },
            {
              type: "fork",
              label: "fork-first",
              from: "source",
              as: "first",
            },
            {
              type: "turn",
              label: "first-fork-delta",
              prompt: THREAD_MERGE_BACK_SIBLINGS_FIRST_FORK_PROMPT,
              thread: "first",
            },
            {
              type: "fork",
              label: "fork-second",
              from: "source",
              as: "second",
            },
            {
              type: "turn",
              label: "second-fork-delta",
              prompt: THREAD_MERGE_BACK_SIBLINGS_SECOND_FORK_PROMPT,
              thread: "second",
            },
            {
              type: "turn",
              label: "merge-first",
              prompt: THREAD_MERGE_BACK_SIBLINGS_FIRST_HANDOFF_PROMPT,
              thread: "source",
            },
            {
              type: "turn",
              label: "merge-second",
              prompt: THREAD_MERGE_BACK_SIBLINGS_SECOND_HANDOFF_PROMPT,
              thread: "source",
            },
            {
              type: "turn",
              label: "source-recall",
              prompt: THREAD_MERGE_BACK_SIBLINGS_RECALL_PROMPT,
              thread: "source",
            },
          ],
        },
      ],
    },
  ];
}

