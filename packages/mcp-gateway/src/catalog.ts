// @effect-diagnostics nodeBuiltinImport:off - the gateway is a plain Node process outside the Effect runtime.
import * as NodeCrypto from "node:crypto";
import { compactJson } from "@t3tools/shared/compactJson";
import * as DateTime from "effect/DateTime";
import { z } from "zod";

import { skillFields } from "./skillInput.ts";
import { GatewayError, GATEWAY_THREAD_EXECUTION_STATES } from "./port.ts";
import {
  callGatewayTool,
  handoffInputSchema,
  threadListWindowFields,
  threadTaskInputFields,
  type GatewayInvocation,
  type GatewayToolContext,
} from "./tools.ts";

const environmentId = z.string().trim().min(1);
const threadId = z.string().trim().min(1);
const discoveryEnvironmentId = environmentId
  .optional()
  .describe(
    "Limit to one environment. Omit to list every connected environment granted read; each result carries environmentId and environmentLabel, and environments reports which machines were listed, skipped, or failed.",
  );
const idempotencyKey = z.string().trim().min(1).max(200);
const scheduledTaskFields = {
  title: z.string().trim().min(1).max(120).optional(),
  prompt: z.string().trim().min(1).max(20_000),
  profileId: z.string().trim().min(1).describe("Agent that runs the task, from t3_list_agents."),
  projectId: z.string().trim().min(1).describe("Project the task's thread works in."),
  runAt: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Run once at this ISO date-time. Pass runAt or cron, not both."),
  cron: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Five-field cron (minute hour day-of-month month weekday), e.g. "0 7 * * 1-5".'),
  timezone: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("IANA time zone for cron, e.g. Europe/London. Defaults to this machine's zone."),
  enabled: z.boolean().optional(),
};
const optionalRequestContext = {
  requestId: z.string().trim().min(1).max(200).optional(),
  correlationId: z.string().trim().min(1).max(200).optional(),
};
const page = {
  afterSequence: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(500).optional(),
};
const pr = {
  environmentId,
  projectId: z.string().trim().min(1),
  repository: z.string().trim().min(1),
  number: z.number().int().min(1),
};
const webhook = { environmentId, webhookId: z.string().trim().min(1) };
const executionState = z.enum(GATEWAY_THREAD_EXECUTION_STATES);

const profileFields = {
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(280).optional(),
  providerLabel: z.string().trim().min(1),
  modelLabel: z.string().trim().min(1),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  icon: z
    .enum(["orb", "bot", "code", "pen", "search", "shield", "sparkles", "terminal"])
    .optional(),
  skillIds: z.array(z.string().trim().min(1)).optional(),
  systemPrompt: z.string().max(32_000).optional(),
  reasoningEffort: z.string().trim().min(1).optional(),
  runtimeMode: z.enum([
    "approval-required",
    "auto-accept-edits",
    "auto",
    "full-access",
    "read-only",
  ]),
  interactionMode: z.enum(["default", "plan"]),
  environmentIds: z.array(z.string().trim().min(1)).optional(),
};

const createThreadFields = {
  environmentId,
  projectId: z.string().trim().min(1),
  title: z.string().trim().min(1),
  profile: z.string().trim().min(1).optional(),
  profileId: z.string().trim().min(1).optional(),
  reasoningEffort: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Thinking level override. Omit to use the agent's configured level."),
  modelSelection: z
    .object({ instanceId: z.string().trim().min(1), model: z.string().trim().min(1) })
    .strict()
    .optional(),
  runtimeMode: z
    .enum(["approval-required", "auto-accept-edits", "auto", "full-access"])
    .optional()
    .describe("Permission mode for chats without an agent. Agent chats always use the agent's."),
  interactionMode: z.enum(["default", "plan"]).optional(),
  workspaceMode: z.enum(["checkout", "worktree"]).optional(),
  baseBranch: z.string().trim().min(1).optional(),
  parentThreadId: z
    .string()
    .trim()
    .min(1)
    .nullable()
    .optional()
    .describe(
      "Chat to show this one under, on any environment. When a T3 chat calls this tool, omitting it makes the calling chat the parent; pass null for a standalone chat.",
    ),
  parentEnvironmentId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Environment of parentThreadId when the parent chat is on another machine."),
  idempotencyKey,
  correlationId: optionalRequestContext.correlationId,
};

export type ToolSpec = readonly [description: string, inputSchema: z.ZodRawShape];

export const TOOL_SPECS = {
  t3_list_skills: [
    "List the shared T3 skills library, including SKILL.md contents, base64 resources, executable flags and revisions. Use skillId with t3_update_skill or assign skillIds using t3_update_agent.",
    { environmentId },
  ],
  t3_create_skill: [
    "Create a reusable skill in the shared T3 Agents library. Supply a name, when-to-use description, and full SKILL.md Markdown content. Optional resources contain relative path, contentBase64, and executable fields; include scripts, references and binary assets without inlining them. Limits: 256 files, 1 MiB per file, 2 MiB per skill. Requires create or admin access and a full-access/default calling chat, since every machine shares the library. Assign the returned skillId to agents with t3_update_agent. Changes sync across connected machines and apply to newly created threads. Existing threads keep their starting skills.",
    { environmentId, ...skillFields },
  ],
  t3_update_skill: [
    "Update a shared skill bundle by skillId. Omit resources to preserve files; supply resources to replace all files (an empty array removes them). New threads for assigned agents receive the change. Existing threads keep their starting skills. Requires create or admin access and a full-access/default calling chat, since every machine shares the library.",
    {
      environmentId,
      skillId: z.string().trim().min(1),
      patch: z.object(skillFields).partial().strict(),
    },
  ],
  t3_delete_skill: [
    "Delete a shared skill from the library. New threads will no longer include it. Existing threads keep their starting skills. Requires create or admin access and a full-access/default calling chat, since every machine shares the library.",
    { environmentId, skillId: z.string().trim().min(1) },
  ],
  t3_list_agents: [
    "List agents from the shared Agents library, including specialization descriptions and model settings. System prompts are left out unless includeSystemPrompt is true (pass environmentId too when you only need one machine). Across environments each agent appears once with availableEnvironmentIds. Use t3_get_agents_view to find their chats/runs. Use profileId to create chats or hand work to an agent.",
    {
      environmentId: discoveryEnvironmentId,
      includeSystemPrompt: z
        .boolean()
        .optional()
        .describe("Include each agent's full systemPrompt, e.g. before t3_update_agent."),
      ...optionalRequestContext,
    },
  ],
  t3_get_agents_view: [
    "List the Agents board across environments (or one): agent specializations and their chat/run summaries, including thread IDs and status. Use this to find an agent’s running or completed work without searching unrelated threads. Filter by profileId, state (active means unsettled, including completed chats), and executionState (for example running or waiting-input). Finished chats remain active until manually settled or automatically settled after their idle age (3 days by default); new activity and un-settling reset the idle clock. Manually settling a parent chat also settles its child chats. Use t3_get_thread or t3_open_thread with a returned threadId for details.",
    {
      environmentId: discoveryEnvironmentId,
      profileId: z.string().trim().min(1).optional(),
      state: z.enum(["active", "settled", "all"]).optional(),
      executionState: executionState.optional(),
      ...optionalRequestContext,
    },
  ],
  t3_create_agent: [
    "Create an agent in the shared Agents library without starting a session. Requires create or admin access and a full-access/default calling chat, since every machine shares the library. Shares to connected machines with the same grant.",
    { environmentId, ...profileFields },
  ],
  t3_update_agent: [
    "Update an agent by profileId. Updated configuration and assigned skillIds apply to newly created threads. Existing threads keep their starting configuration and skill contents. Requires create or admin access and a full-access/default calling chat, since every machine shares the library.",
    {
      environmentId,
      profileId: z.string().trim().min(1),
      patch: z.object(profileFields).partial().strict(),
    },
  ],
  t3_delete_agent: [
    "Remove an agent from the shared Agents library, retaining its chats. Requires create or admin access and a full-access/default calling chat, since every machine shares the library.",
    { environmentId, profileId: z.string().trim().min(1) },
  ],
  t3_handoff_thread: [
    "Hand work to a new agent chat: save a Markdown brief with a reviewed summary and selected source file contents, then send the destination task. Use a stable handoffId UUID for retries. Source conversation remains intact. After success ASK the user whether to settle it; never infer approval. A created status means delivery failed: open the returned thread to recover rather than making another chat.",
    handoffInputSchema.shape,
  ],
  t3_settle_thread: [
    "Settle a conversation only after the user explicitly chooses to settle it. Requires lifecycle scope. Does not delete the conversation. Its child chats and delegated subagents settle with it; ones still working follow this manual cascade when they finish. Do not call automatically after a handoff.",
    { environmentId, threadId, confirmed: z.literal(true) },
  ],
  t3_unsettle_thread: [
    "Return a settled chat to active work in its agent column, with the child chats and subagents that settled along with it. Unsettling restarts the idle clock. Requires lifecycle scope. Does not send a message or start a turn.",
    { environmentId, threadId },
  ],
  t3_set_thread_parent: [
    "Make a chat a child of another chat, move it to a different parent, or pass parentThreadId null to make it top-level again. A child is a full agent chat with its own context; it shows inside its parent's card on the Agents board. The parent may be on another environment (pass parentEnvironmentId). List a chat's children with t3_list_threads parentThreadId. The change is all or nothing and safe to repeat. It fails with a reason, leaving the link unchanged, when the chat would go under itself or one of its own children, when the parent is missing, deleted, or archived, or when the chat is a subagent, which stays with the thread whose run spawned it. Requires lifecycle scope. Does not start or stop a turn.",
    {
      environmentId,
      threadId,
      parentThreadId: z
        .string()
        .trim()
        .min(1)
        .nullable()
        .describe("The chat to nest under, or null to detach."),
      parentEnvironmentId: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("Environment of parentThreadId when the parent chat is on another machine."),
    },
  ],
  t3_open_agents: [
    "Open the Agents board in the connected desktop app and reveal its window.",
    { environmentId },
  ],
  t3_list_environments: ["List T3 environments granted to this host.", optionalRequestContext],
  t3_get_environment_status: [
    "Get connection state for one T3 environment.",
    { environmentId, ...optionalRequestContext },
  ],
  t3_get_presence: [
    "Whether someone is at a T3 client of this environment right now: present is true when any live client is visible or focused. Also reports recent interaction, lastActivityAt (ISO time of the latest client report, or null), and each live client's state. Use it to hold back notifications while the user is at the computer. Requires read scope.",
    { environmentId, ...optionalRequestContext },
  ],
  t3_get_environment_health: [
    "Get authoritative runtime health for one environment.",
    { environmentId, ...optionalRequestContext },
  ],
  t3_get_gateway_health: [
    "Get MCP, bridge, event retention, and delivery queue health.",
    optionalRequestContext,
  ],
  t3_list_projects: [
    "List projects across T3 environments, or in one.",
    { environmentId: discoveryEnvironmentId, ...optionalRequestContext },
  ],
  t3_list_threads: [
    "List chats across every connected T3 environment (or one), most recently updated first. Returns the latest 20 unless you pass limit (max 100). When hasMore is true, pass nextCursor back as cursor with the same filters for the next page. Narrow with agent profileId, project, parentThreadId, active/settled state, executionState, and the updatedAfter, updatedBefore, and createdAfter ISO times; use updatedBefore or cursor to reach older chats. state=active means unsettled (it still includes completed or stopped chats); use executionState to select running or waiting-input/waiting-approval work explicitly. Finished chats remain active until manually settled or automatically settled after their idle age (3 days by default); new activity and un-settling reset the idle clock. Manually settling a parent chat also settles its child chats. Rows are summaries: read one chat with t3_get_thread or its messages with t3_get_messages. hasPendingUserInput marks a chat waiting on a question; pass includeQuestions to attach each one's pendingQuestions (full text and options, as t3_get_pending_questions returns). profileId and profileName name the chat's agent; read its instructions with t3_list_agents includeSystemPrompt.",
    {
      environmentId: discoveryEnvironmentId,
      state: z.enum(["all", "active", "settled"]).optional(),
      executionState: executionState.optional(),
      projectId: z.string().trim().min(1).optional(),
      profileId: z.string().trim().min(1).optional(),
      parentThreadId: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("Only chats created under this chat."),
      parentEnvironmentId: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("With parentThreadId, the parent chat's environment."),
      includeQuestions: z
        .boolean()
        .optional()
        .describe("Attach pendingQuestions to chats waiting on a question."),
      ...threadListWindowFields,
      ...optionalRequestContext,
    },
  ],
  t3_get_pending_questions: [
    "Read the questions a chat is waiting on (status waiting-input): each request's questionRequestId, and for every question its questionId, header, full question text, options (label and description), multiSelect, and allowsFreeText (whether a typed answer is accepted instead of an option). Empty when nothing is pending. Answer with t3_answer_question.",
    { environmentId, threadId, ...optionalRequestContext },
  ],
  t3_answer_question: [
    "Answer a question a chat is waiting on, so its turn continues. For each question pass options (option labels from t3_get_pending_questions; exactly one unless multiSelect) or text (only where allowsFreeText). Every question in the request must be answered. questionRequestId and questionId may be omitted when there is only one. Requires send scope. Retrying with the same idempotencyKey does not answer twice.",
    {
      environmentId,
      threadId,
      questionRequestId: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("From t3_get_pending_questions; omit when the chat has one pending request."),
      answers: z
        .array(
          z.object({
            questionId: z
              .string()
              .trim()
              .min(1)
              .optional()
              .describe("Omit when the request asks a single question."),
            options: z
              .array(z.string().min(1))
              .optional()
              .describe("Chosen option labels. Several only for multiSelect questions."),
            text: z
              .string()
              .trim()
              .min(1)
              .optional()
              .describe("A typed answer instead of options, where allowsFreeText."),
          }),
        )
        .min(1),
      idempotencyKey,
      correlationId: optionalRequestContext.correlationId,
    },
  ],
  t3_open_thread: [
    "Open a local or remote chat in the connected desktop app and reveal its window. Requires read access; does not start or stop a turn.",
    { environmentId, threadId },
  ],
  t3_list_devices: [
    "List T3 apps (desktop, web, mobile) connected to an environment that you can bring content on screen for with t3_focus_device. focused/visible show which device the user is looking at now. A device connected to several environments appears once per environment.",
    { environmentId },
  ],
  t3_focus_device: [
    "Bring a chat, a file, or the Agents board on screen on one connected device, e.g. pull a chat into focus on the user's other computer or phone. Pass device as a deviceId or exact label from t3_list_devices. With threadId alone the chat opens; add path to also preview a file from that chat's workspace (images, video, PDF, code; absolute paths may point anywhere the environment host can read) and line to reveal a line. view=agents opens the Agents board instead. Does not start or stop a turn.",
    {
      environmentId,
      device: z.string().trim().min(1),
      threadId: threadId.optional(),
      path: z.string().trim().min(1).max(1024).optional(),
      line: z.number().int().min(1).optional(),
      view: z.enum(["thread", "agents"]).optional(),
    },
  ],
  t3_list_scheduled_tasks: [
    "List scheduled tasks on an environment: prompts that run on an agent at a set time or on a cron schedule. Each task posts every run into one thread (threadId, null until the first run). Shows enabled, nextRunAt, and the last run's status and error.",
    { environmentId },
  ],
  t3_create_scheduled_task: [
    "Schedule a prompt to run on an agent, once (runAt) or repeatedly (cron + timezone). The first run creates the task's thread from the agent profile in the project; later runs post into the same thread. The task is stored on and runs on the environment that hosts the project, so pass that environment (omit it for this chat's own machine), not the device you are talking through. Tasks run only while that environment's server is up; a run missed while it was down fires once when it returns. Runs use the agent's permission mode, so an agent that needs approvals will wait for them. Requires create or admin access.",
    { environmentId, ...scheduledTaskFields },
  ],
  t3_update_scheduled_task: [
    "Change a scheduled task by taskId: prompt, title, schedule (runAt or cron/timezone), agent, project, or enabled to pause/resume. Changing agent or project starts a new thread on the next run. Re-arming a finished one-time task needs a future runAt. Requires create or admin access.",
    {
      environmentId,
      taskId: z.string().trim().min(1),
      patch: z.object(scheduledTaskFields).partial().strict(),
    },
  ],
  t3_delete_scheduled_task: [
    "Delete a scheduled task. Its thread and past runs are kept. Requires create or admin access.",
    { environmentId, taskId: z.string().trim().min(1) },
  ],
  t3_run_scheduled_task: [
    "Run a scheduled task's prompt now, in its thread, without changing its schedule. Requires send access.",
    { environmentId, taskId: z.string().trim().min(1) },
  ],
  t3_list_todos: [
    "List a project's todos. A project with a git remote shares one list with every checkout and worktree of that repository on the environment; a folder without one has its own. Active todos come first, oldest first, then up to 50 recently settled ones; settledCount counts every settled todo.",
    { environmentId, projectId: z.string().trim().min(1) },
  ],
  t3_add_todo: [
    "Add a todo to a project's list, shared across worktrees of the same repository. Returns the todo with its id. Requires create access.",
    { environmentId, projectId: z.string().trim().min(1), text: z.string().trim().min(1).max(500) },
  ],
  t3_update_todo: [
    "Change a todo's text. Requires create access.",
    { environmentId, todoId: z.string().trim().min(1), text: z.string().trim().min(1).max(500) },
  ],
  t3_settle_todo: [
    "Settle a todo: it is done and leaves the active list. Undo with t3_unsettle_todo; settling a settled todo changes nothing. Requires create access.",
    { environmentId, todoId: z.string().trim().min(1) },
  ],
  t3_unsettle_todo: [
    "Return a settled todo to the active list. Requires create access.",
    { environmentId, todoId: z.string().trim().min(1) },
  ],
  t3_remove_todo: [
    "Delete a todo permanently. To mark finished work, settle it instead; removal cannot be undone. Requires create access.",
    { environmentId, todoId: z.string().trim().min(1) },
  ],
  t3_task_assign: [
    "Assign or replace the task of a child chat nested under this chat. The child records WAITING, INPUT, or DONE against it. Child activity never sends you automatic chat messages: wait for its thread to end, then read it, or watch/read its task state. Named children you launch get a task automatically. settleWhenAccepted is standing consent to settle the child after you accept its DONE revision; it is not acceptance. For a child on another machine pass its environmentId: its environment keeps the task and delivers changes back to you, and reads show sync state when it is unreachable. Requires create or admin access.",
    { environmentId, ...threadTaskInputFields.assign },
  ],
  t3_task_read: [
    "Read a task: your own as a worker, a child's as its owner, or omit threadId for every task you own or work on. Returns status, revision, needs, evidence, waitingOn, checkBack, whether that continuation is live, the worker's run state, and acceptance and settlement, plus a cursor. To re-check your tasks, pass that cursor as afterCursor (without threadId): you get only tasks changed since, and `removed` lists chats whose tasks moved to another owner.",
    { environmentId, ...threadTaskInputFields.read },
  ],
  t3_task_update: [
    "Update a task at expectedRevision. Workers report WAITING (waitingOn: their run, a watched pull request, or a child task), INPUT (needs: the missing decision or dependency; questionRequestId for a pending question), or DONE (evidence required, child tasks accepted). Task updates stay readable and never send automatic chat messages to the owner. Bump the task only for actionable changes (a result, blocker, handover, failure, or DONE); keep progress in your own notes. When your own watcher carries the work, stay WAITING and set checkBack to record its expected deadline for the owner to read. Owner only: accept=true accepts the current DONE revision once its merge or deployment gates passed; settleWhenAccepted grants or withdraws settlement consent. Any content change reopens the task and clears acceptance. Requires create or admin access.",
    { environmentId, ...threadTaskInputFields.update },
  ],
  t3_task_watch: [
    "Wait up to timeoutMs (max 60000) for changes to tasks you own or work on after afterCursor, returning as soon as one changes. Omit afterCursor for the current tasks and cursor. Task changes never send you a message or wake you after your turn ends; this call only holds the current turn until one arrives.",
    { environmentId, ...threadTaskInputFields.watch },
  ],
  t3_task_board: [
    "Read-only view of a project's tasks on this environment and every environment your connected T3 app reaches, grouped by the chat that owns them, so Captains see each other's domains. coverage lists each environment as local, live, or unreachable; a child on an unreachable environment is shown from your own mirror (source mirror) and may be stale. Changes go through t3_task_update on your own tasks only. Captains and the user; workers read their own task. Requires read access.",
    { environmentId, ...threadTaskInputFields.board },
  ],
  t3_settle_after_turn: [
    "Settle this chat (or threadId) once its current turn ends and nothing remains: no queued wake, active descendant, or unaccepted child task. Returns the request with blockedBy while it waits; cancel=true withdraws it. Use instead of settling a chat that is still running. Requires lifecycle scope.",
    { environmentId, ...threadTaskInputFields.settleAfterTurn },
  ],
  t3_get_thread: [
    "Read one T3 chat and its messages, including its profileSnapshot.",
    { environmentId, threadId, ...optionalRequestContext },
  ],
  t3_summarize_thread: [
    "Summarize authoritative thread state and the next action.",
    { environmentId, threadId, ...optionalRequestContext },
  ],
  t3_get_messages: [
    "Read recent messages from one T3 chat.",
    {
      environmentId,
      threadId,
      limit: z.number().int().min(1).max(100).optional(),
      ...optionalRequestContext,
    },
  ],
  t3_get_operation_history: [
    "Read durable operation events after a sequence cursor.",
    { environmentId, threadId: threadId.optional(), ...page, ...optionalRequestContext },
  ],
  t3_wait_for_thread_status: [
    "Wait (bounded) for one chat’s execution status to change. Reuses the durable replay/live event stream: pass afterSequence from a previous result to catch up without missing a transition, or omit it to start from the current position. Returns status, previousStatus, changed, matched, timedOut, and cursor for the next call. Waits until timeoutMs (default 30000) elapses; a waiting-input/waiting-approval status means the chat needs the user.",
    {
      environmentId,
      threadId,
      untilStatuses: z.array(executionState).min(1).optional(),
      afterSequence: z.number().int().min(0).optional(),
      timeoutMs: z.number().int().min(250).max(120_000).optional(),
      ...optionalRequestContext,
    },
  ],
  t3_create_thread: [
    "Create a chat with an immutable resolved profile snapshot. For agent tasks, pass profileId from t3_list_agents to snapshot that agent’s instructions and settings. Then use t3_send_message to start work. Prefer t3_create_and_start_thread when you already have the opening task.",
    createThreadFields,
  ],
  t3_create_and_start_thread: [
    "Create a chat and send its opening task in one idempotent operation. Requires create and send scope. Retrying with the same idempotencyKey reuses the same chat and message instead of duplicating work. Returns explicit creation, message delivery, and current executionState; partial means the chat exists but the message was not confirmed, so inspect the returned threadId and retry rather than creating another chat.",
    { ...createThreadFields, text: z.string().trim().min(1) },
  ],
  t3_send_message: [
    "Send a user message to an existing T3 chat.",
    {
      environmentId,
      threadId,
      text: z.string().trim().min(1),
      idempotencyKey,
      correlationId: optionalRequestContext.correlationId,
    },
  ],
  t3_control_thread: [
    "Cancel, stop, pause, resume, retry, or restart a T3 chat.",
    {
      environmentId,
      threadId,
      action: z.enum(["cancel", "stop", "pause", "resume", "retry", "restart"]),
      idempotencyKey,
      correlationId: optionalRequestContext.correlationId,
    },
  ],
  t3_stop_thread: [
    "Request stopping the thread provider session. Requires control or lifecycle scope. Accepted is not confirmed stopped: verify session status with t3_get_thread. Does not remove queued messages.",
    {
      environmentId,
      threadId,
      idempotencyKey,
      correlationId: optionalRequestContext.correlationId,
    },
  ],
  t3_cancel_thread: [
    "Cancel queued or running thread work.",
    {
      environmentId,
      threadId,
      idempotencyKey,
      correlationId: optionalRequestContext.correlationId,
    },
  ],
  t3_pause_thread: [
    "Request interruption of active thread work. Requires control or lifecycle scope. Accepted is not confirmed paused: read the thread until its turn/session is no longer running. Does not pause queued messages or suspend a provider process.",
    {
      environmentId,
      threadId,
      idempotencyKey,
      correlationId: optionalRequestContext.correlationId,
    },
  ],
  t3_resume_thread: [
    "Resume paused or interrupted thread work.",
    {
      environmentId,
      threadId,
      idempotencyKey,
      correlationId: optionalRequestContext.correlationId,
    },
  ],
  t3_retry_thread: [
    "Retry failed or interrupted thread work.",
    {
      environmentId,
      threadId,
      idempotencyKey,
      correlationId: optionalRequestContext.correlationId,
    },
  ],
  t3_restart_thread: [
    "Start a fresh execution attempt without erasing history.",
    {
      environmentId,
      threadId,
      idempotencyKey,
      correlationId: optionalRequestContext.correlationId,
    },
  ],
  t3_respond_to_approval: [
    "Approve or reject one pending T3 action.",
    {
      environmentId,
      threadId,
      approvalRequestId: z.string().trim().min(1),
      decision: z.enum(["accept", "acceptForSession", "decline", "cancel"]),
      confirmDestructive: z.boolean().optional(),
      idempotencyKey,
      correlationId: optionalRequestContext.correlationId,
    },
  ],
  t3_subscribe_events: [
    "Create a durable replay-then-live MCP event subscription.",
    {
      environmentId,
      types: z.array(z.string().trim().min(1)).optional(),
      afterSequence: z.number().int().min(0).optional(),
      ...optionalRequestContext,
    },
  ],
  t3_get_events: [
    "Replay retained environment events after a sequence cursor.",
    {
      environmentId,
      types: z.array(z.string().trim().min(1)).optional(),
      ...page,
      ...optionalRequestContext,
    },
  ],
  t3_replay_events: [
    "Replay retained events for a durable subscription.",
    {
      environmentId,
      subscriptionId: z.string().trim().min(1),
      limit: z.number().int().min(1).max(500).optional(),
      ...optionalRequestContext,
    },
  ],
  t3_ack_events: [
    "Acknowledge processed events monotonically.",
    {
      environmentId,
      subscriptionId: z.string().trim().min(1),
      throughSequence: z.number().int().min(0),
      ...optionalRequestContext,
    },
  ],
  t3_register_webhook: [
    "Register an HTTPS webhook; return its signing secret once.",
    {
      environmentId,
      url: z.string().trim().url(),
      types: z.array(z.string().trim().min(1)).optional(),
      ...optionalRequestContext,
    },
  ],
  t3_update_webhook: [
    "Update an existing webhook event filter.",
    { ...webhook, types: z.array(z.string().trim().min(1)).optional(), ...optionalRequestContext },
  ],
  t3_rotate_webhook_secret: [
    "Rotate a webhook secret without moving its cursor.",
    { ...webhook, ...optionalRequestContext },
  ],
  t3_delete_webhook: ["Delete an existing webhook.", { ...webhook, ...optionalRequestContext }],
  t3_list_webhooks: [
    "List registered webhooks for one environment.",
    { environmentId, ...optionalRequestContext },
  ],
  t3_get_pr: ["Read pull request state.", { ...pr, ...optionalRequestContext }],
  t3_get_pr_checks: ["Read pull request checks.", { ...pr, ...optionalRequestContext }],
  t3_list_review_comments: [
    "List unresolved pull request review threads.",
    { ...pr, ...optionalRequestContext },
  ],
  t3_git_status: [
    "Read repository working tree and branch status.",
    { environmentId, projectId: z.string().trim().min(1), ...optionalRequestContext },
  ],
  t3_get_diff: [
    "Read the bounded thread diff.",
    { environmentId, threadId, ...optionalRequestContext },
  ],
  t3_reclaim_worktree: [
    "Free the disk used by a finished thread's T3-managed worktree. Removes the checkout while the thread keeps its history, branch and worktree binding; its next turn recreates the checkout from the branch. Refuses, listing every reason, while the thread or any child is working, another thread shares the checkout, a provider session or terminal is open there, or the checkout has uncommitted changes, ignored files that cannot be regenerated, unpushed commits or an unmerged branch. dryRun reports eligibility and allocated bytes without removing anything. Requires lifecycle scope, or read for dryRun.",
    {
      environmentId,
      threadId,
      dryRun: z.boolean().optional(),
      ...optionalRequestContext,
    },
  ],
  t3_apply_patch: [
    "Apply a patch through the authoritative T3 runtime.",
    {
      environmentId,
      projectId: z.string().trim().min(1),
      patch: z.string().min(1),
      idempotencyKey,
      correlationId: optionalRequestContext.correlationId,
    },
  ],
  t3_create_branch: [
    "Create a repository branch.",
    {
      environmentId,
      projectId: z.string().trim().min(1),
      branch: z.string().trim().min(1),
      idempotencyKey,
      correlationId: optionalRequestContext.correlationId,
    },
  ],
  t3_commit_changes: [
    "Commit selected repository changes.",
    {
      environmentId,
      projectId: z.string().trim().min(1),
      message: z.string().trim().min(1),
      paths: z.array(z.string().trim().min(1)).optional(),
      idempotencyKey,
      correlationId: optionalRequestContext.correlationId,
    },
  ],
  t3_create_pr: [
    "Create a fork pull request, draft by default.",
    {
      environmentId,
      projectId: z.string().trim().min(1),
      repository: z.string().trim().min(1),
      owner: z.string().trim().min(1),
      headBranch: z.string().trim().min(1),
      baseBranch: z.string().trim().min(1),
      title: z.string().trim().min(1),
      body: z.string().optional(),
      draft: z.boolean().default(true),
      idempotencyKey,
      correlationId: optionalRequestContext.correlationId,
    },
  ],
  t3_update_pr: [
    "Update pull request title or body.",
    {
      ...pr,
      title: z.string().trim().min(1).optional(),
      body: z.string().optional(),
      idempotencyKey,
      correlationId: optionalRequestContext.correlationId,
    },
  ],
  t3_reply_review_comment: [
    "Reply to a pull request review thread.",
    {
      ...pr,
      commentId: z.string().trim().min(1),
      body: z.string().min(1),
      idempotencyKey,
      correlationId: optionalRequestContext.correlationId,
    },
  ],
  t3_apply_review_fixes: [
    "Apply approved review fixes while preserving unresolved state until refresh.",
    {
      environmentId,
      threadId,
      projectId: z.string().trim().min(1),
      repository: z.string().trim().min(1),
      number: z.number().int().min(1),
      commentIds: z.array(z.string().trim().min(1)).min(1),
      idempotencyKey,
      correlationId: optionalRequestContext.correlationId,
    },
  ],
  t3_publish_pr: [
    "Publish a draft pull request with destructive confirmation.",
    {
      ...pr,
      confirmDestructive: z.literal(true),
      idempotencyKey,
      correlationId: optionalRequestContext.correlationId,
    },
  ],
} satisfies Record<string, ToolSpec>;

export const LIFECYCLE_ALIASES: Readonly<Record<string, string>> = {
  t3_stop_thread: "stop",
  t3_cancel_thread: "cancel",
  t3_pause_thread: "pause",
  t3_resume_thread: "resume",
  t3_retry_thread: "retry",
  t3_restart_thread: "restart",
};

export function requestContext(args: Record<string, unknown>) {
  return {
    requestId:
      typeof args.requestId === "string"
        ? args.requestId
        : typeof args.idempotencyKey === "string"
          ? args.idempotencyKey
          : `req_${NodeCrypto.randomUUID()}`,
    correlationId:
      typeof args.correlationId === "string"
        ? args.correlationId
        : `corr_${NodeCrypto.randomUUID()}`,
  };
}

/**
 * The envelope echoes only the request and correlation IDs the caller supplied: generated ones
 * were never seen by the caller. The text block, which text-reading harnesses put in the model's
 * context, also leaves out null and empty-array fields; `structuredContent` keeps every field.
 */
export function success(value: unknown, args: Record<string, unknown>) {
  const supplied = (key: string) => (typeof args[key] === "string" ? args[key] : undefined);
  const requestId = supplied("requestId") ?? supplied("idempotencyKey");
  const correlationId = supplied("correlationId");
  const body = {
    schemaVersion: "3",
    ...(requestId === undefined ? {} : { requestId }),
    ...(correlationId === undefined ? {} : { correlationId }),
    serverTime: DateTime.formatIso(DateTime.nowUnsafe()),
    data: value,
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(compactJson(body)) }],
    structuredContent: body,
  };
}

export function failure(error: unknown, context: ReturnType<typeof requestContext>) {
  const detail: Record<string, unknown> =
    error instanceof GatewayError
      ? error.toJSON()
      : {
          code: "upstream_failure",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        };
  const body = {
    schemaVersion: "3",
    error: {
      ...detail,
      requestId: typeof detail.requestId === "string" ? detail.requestId : context.requestId,
      correlationId: context.correlationId,
    },
  };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(body) }],
    structuredContent: body,
  };
}

export type GatewayToolName = keyof typeof TOOL_SPECS;

/**
 * Tools that read the gateway's own event store or bridge health. Every other tool runs
 * anywhere with a runtime port, including inside a T3 server's `t3-code` MCP.
 */
export const GATEWAY_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "t3_get_gateway_health",
  "t3_get_operation_history",
  "t3_wait_for_thread_status",
  "t3_subscribe_events",
  "t3_get_events",
  "t3_replay_events",
  "t3_ack_events",
  "t3_register_webhook",
  "t3_update_webhook",
  "t3_rotate_webhook_secret",
  "t3_delete_webhook",
  "t3_list_webhooks",
]);

/**
 * Lifecycle aliases a T3 server's `t3-code` MCP leaves out: t3_control_thread takes the same
 * arguments, on any environment, and runs the same action. The standalone gateway keeps them.
 */
export const SERVER_SUPERSEDED_TOOLS: ReadonlySet<string> = new Set(Object.keys(LIFECYCLE_ALIASES));

/** Runs one tool by its public name (aliases included) and wraps the result in the v3 envelope. */
export async function runGatewayTool(
  context: GatewayToolContext,
  name: string,
  args: Record<string, unknown>,
  invocation: GatewayInvocation = {},
) {
  try {
    const aliasAction = LIFECYCLE_ALIASES[name];
    const toolName = aliasAction === undefined ? name : "t3_control_thread";
    const normalizedArgs = aliasAction === undefined ? args : { ...args, action: aliasAction };
    const value = await callGatewayTool(context, toolName, normalizedArgs, invocation);
    return { ok: true as const, value, result: success(value, args) };
  } catch (error) {
    return { ok: false as const, error, result: failure(error, requestContext(args)) };
  }
}

/**
 * JSON Schema for a tool's input. With `environmentDefault`, `environmentId` becomes optional:
 * a T3 server hosting the tools fills in its own environment.
 */
/** True when the tool acts on one environment that callers must name. */
export function requiresEnvironment(name: string): boolean {
  const environment = (TOOL_SPECS as Record<string, ToolSpec>)[name]?.[1].environmentId as
    | z.ZodType
    | undefined;
  return environment !== undefined && !environment.safeParse(undefined).success;
}

/**
 * The tool's input JSON schema. With `environmentDefault`, a required environmentId becomes
 * optional for callers that run on an environment of their own.
 */
export function toolInputJsonSchema(
  name: string,
  options: { readonly environmentDefault?: boolean } = {},
): Record<string, unknown> {
  const spec = (TOOL_SPECS as Record<string, ToolSpec>)[name];
  if (spec === undefined) throw new Error(`Unknown gateway tool ${name}.`);
  const shape = spec[1];
  const input =
    options.environmentDefault === true && requiresEnvironment(name)
      ? {
          ...shape,
          environmentId: (shape.environmentId as z.ZodType)
            .optional()
            .describe(
              "Environment to act on. Omit to use the machine this chat runs on; pass another environment's ID to act there through your connected T3 app.",
            ),
        }
      : shape;
  return z.toJSONSchema(z.strictObject(input)) as Record<string, unknown>;
}
