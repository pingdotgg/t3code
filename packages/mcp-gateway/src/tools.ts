// @effect-diagnostics nodeBuiltinImport:off - the gateway is a plain Node process outside the Effect runtime.
import { profileFields } from "./profileInput.ts";
import { skillFields } from "./skillInput.ts";
import { z } from "zod";
import * as NodeCrypto from "node:crypto";

import {
  GatewayError,
  GATEWAY_THREAD_EXECUTION_STATES,
  type GatewayApprovalDecision,
  type GatewayFocusTarget,
  type GatewayProfile,
  type GatewayRuntimePort,
  type GatewayScheduledTaskCreate,
  type GatewayScheduledTaskPatch,
  type GatewayScope,
  type GatewayThreadControlAction,
  type GatewayThreadExecutionState,
  type GatewayThreadTaskRequest,
} from "./port.ts";
import type { GatewayEvent, GatewayEventStore } from "./events.ts";
import type { ScheduledTaskSchedule } from "@t3tools/contracts";

export type GatewayGrants = Readonly<Record<string, ReadonlyArray<GatewayScope>>>;
export type GatewayGrantSource = GatewayGrants | (() => GatewayGrants);
export type GatewayProfileSource =
  | ReadonlyArray<GatewayProfile>
  | (() => ReadonlyArray<GatewayProfile>);

export interface GatewayToolContext {
  readonly port: GatewayRuntimePort;
  readonly grants: GatewayGrantSource;
  readonly profiles?: GatewayProfileSource;
  readonly repositoryAllowlist?: ReadonlyArray<string>;
  readonly events?: GatewayEventStore;
  readonly health?: () => {
    readonly bridge: "connected" | "disconnected" | "degraded";
    readonly degradedReasons: ReadonlyArray<string>;
  };
}

/** The T3 chat whose agent made a tool call, when it came from a thread. */
export interface GatewayCaller {
  readonly environmentId: string;
  readonly threadId: string;
}

export interface GatewayInvocation {
  readonly caller?: GatewayCaller | undefined;
}

const taskText = (max: number) => z.string().trim().min(1).max(max);
const taskRequestId = taskText(256).optional();
const taskThreadId = z.string().trim().min(1);
const taskContinuation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run") }),
  z.object({
    kind: z.literal("pull_request"),
    repository: z.string().trim().min(1),
    number: z.number().int().positive(),
  }),
  z.object({ kind: z.literal("task"), threadId: taskThreadId }),
]);

const THREAD_LIST_DEFAULT_LIMIT = 20;
const isoTime = z
  .string()
  .trim()
  .refine((value) => !Number.isNaN(Date.parse(value)), "must be an ISO date or time");

/** t3_list_threads paging and time-window inputs. */
export const threadListWindowFields = {
  updatedAfter: isoTime.optional().describe("Only chats updated at or after this ISO time."),
  updatedBefore: isoTime.optional().describe("Only chats updated before this ISO time."),
  createdAfter: isoTime.optional().describe("Only chats created at or after this ISO time."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe(`Chats per page, newest first. Default ${THREAD_LIST_DEFAULT_LIMIT}.`),
  cursor: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("nextCursor from the previous page; keep the other filters the same."),
};

/** Tool inputs for thread tasks, without environmentId. The caller is never an input. */
export const threadTaskInputFields = {
  assign: {
    threadId: taskThreadId.describe("The child chat that works on the task."),
    summary: taskText(2000).describe("The deliverable, in a sentence or two."),
    taskId: taskText(128)
      .optional()
      .describe("Your ledger's id for the task. Defaults to a new id."),
    settleWhenAccepted: z
      .boolean()
      .optional()
      .describe(
        "Standing consent to settle the child once you accept its DONE revision. Not acceptance itself.",
      ),
    clientRequestId: taskRequestId,
  },
  read: {
    threadId: taskThreadId
      .optional()
      .describe(
        "A child chat whose task you own, or your own chat. Omit to list every task you own.",
      ),
    afterCursor: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Without threadId: only tasks changed after this cursor from an earlier read, plus `removed`. Omit for every task.",
      ),
  },
  update: {
    threadId: taskThreadId.optional().describe("The worker chat. Omit to update your own task."),
    expectedRevision: z
      .number()
      .int()
      .positive()
      .describe("The revision you read. A newer revision rejects the update."),
    status: z.enum(["WAITING", "INPUT", "DONE"]).optional(),
    summary: taskText(2000).optional(),
    needs: taskText(2000)
      .nullable()
      .optional()
      .describe("INPUT only: the missing decision or dependency."),
    questionRequestId: z.string().trim().min(1).nullable().optional(),
    evidence: z.array(taskText(1000)).max(20).optional(),
    waitingOn: taskContinuation.nullable().optional(),
    checkBack: z
      .object({
        minutes: z.number().int().min(1).max(1440),
        note: taskText(500).describe("What your own watcher is waiting for."),
      })
      .nullable()
      .optional()
      .describe(
        "WAITING only: your own watcher (background command, monitor, external script) covers this task. Record its expected deadline in `minutes` (max 1440) for your owner to read; passing it never sends an automatic chat message. Does not change the revision. null clears it; any content change also clears it.",
      ),
    settleWhenAccepted: z.boolean().optional().describe("Owner only."),
    accept: z
      .literal(true)
      .optional()
      .describe(
        "Owner only: accept this DONE revision after its gates (merge, deployment) passed.",
      ),
    clientRequestId: taskRequestId,
  },
  watch: {
    afterCursor: z.number().int().min(0).optional(),
    timeoutMs: z.number().int().min(1).max(60_000).optional(),
  },
  board: {
    projectKey: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .optional()
      .describe("Omit for your own chat's project."),
  },
  settleAfterTurn: {
    threadId: taskThreadId
      .optional()
      .describe("Omit for your own chat. Only that chat or the user may ask."),
    cancel: z.literal(true).optional().describe("Withdraw a pending request."),
  },
} as const;

export const handoffInputSchema = z.object({
  sourceEnvironmentId: z.string().min(1),
  sourceThreadId: z.string().min(1),
  environmentId: z.string().min(1),
  projectId: z.string().min(1),
  profileId: z.string().min(1),
  handoffId: z.string().uuid(),
  title: z.string().max(200),
  summary: z.string().trim().min(1).max(64000),
  prompt: z.string().trim().min(1).max(16000),
  files: z.array(z.string().min(1)).max(10).optional(),
});

const profileInput = z.object(profileFields);

const skillInput = z.object(skillFields);

async function shareSkills(context: GatewayToolContext, sourceId: string) {
  const failedEnvironmentIds: string[] = [];
  const grants = currentGrants(context.grants);
  for (const environment of await context.port.listEnvironments()) {
    const id = environment.environmentId;
    if (
      id === sourceId ||
      environment.connectionState !== "connected" ||
      !grants[id]?.some((scope) => scope === "create" || scope === "admin")
    )
      continue;
    try {
      if (!context.port.syncAgentLibrary) throw new Error("Skill sharing unavailable.");
      await context.port.syncAgentLibrary(id);
    } catch {
      failedEnvironmentIds.push(id);
    }
  }
  return { failedEnvironmentIds };
}

async function shareProfiles(
  context: GatewayToolContext,
  sourceId: string,
  deletedAt?: Readonly<Record<string, string>>,
) {
  const profiles = await authoritativeProfiles(context, sourceId);
  const environments = await context.port.listEnvironments();
  const failedEnvironmentIds: string[] = [];
  const grants = currentGrants(context.grants);
  for (const environment of environments) {
    const id = environment.environmentId;
    if (
      id === sourceId ||
      environment.connectionState !== "connected" ||
      !grants[id]?.some((scope) => scope === "create" || scope === "admin")
    )
      continue;
    try {
      if (!context.port.replicateProfiles) throw new Error("Profile sharing unavailable.");
      if (deletedAt) await context.port.replicateProfiles(id, profiles, deletedAt);
      else await context.port.replicateProfiles(id, profiles);
    } catch {
      failedEnvironmentIds.push(id);
    }
  }
  return { failedEnvironmentIds };
}

function currentGrants(source: GatewayGrantSource): GatewayGrants {
  return Object.assign(Object.create(null), typeof source === "function" ? source() : source);
}

async function authoritativeProfiles(
  context: GatewayToolContext,
  environmentId: string,
): Promise<ReadonlyArray<GatewayProfile>> {
  return context.port.listProfiles === undefined ? [] : context.port.listProfiles(environmentId);
}

function record(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new GatewayError({
      code: "invalid_input",
      message: "Tool input must be an object.",
      retryable: false,
    });
  }
  return input as Record<string, unknown>;
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new GatewayError({
      code: "invalid_input",
      message: `${key} must be a non-empty string.`,
      retryable: false,
    });
  }
  return value;
}

function focusTargetFromInput(input: Record<string, unknown>): GatewayFocusTarget {
  const invalid = (message: string) =>
    new GatewayError({ code: "invalid_input", message, retryable: false });
  const threadId = typeof input.threadId === "string" ? input.threadId.trim() : "";
  const path = typeof input.path === "string" ? input.path.trim() : "";
  const line = typeof input.line === "number" ? input.line : undefined;
  if (input.view === "agents") {
    if (threadId !== "" || path !== "") throw invalid("view=agents takes no threadId or path.");
    return { type: "agents" };
  }
  if (threadId === "") throw invalid("threadId is required unless view=agents.");
  if (path !== "") return { type: "file", threadId, path, ...(line === undefined ? {} : { line }) };
  if (line !== undefined) throw invalid("line requires path.");
  return { type: "thread", threadId };
}

/** Builds a schedule from runAt or cron input; returns undefined when neither was given. */
function scheduleFromInput(input: Record<string, unknown>): ScheduledTaskSchedule | undefined {
  const invalid = (message: string) =>
    new GatewayError({ code: "invalid_input", message, retryable: false });
  const runAt = typeof input.runAt === "string" ? input.runAt : undefined;
  const cron = typeof input.cron === "string" ? input.cron : undefined;
  if (runAt !== undefined && cron !== undefined) throw invalid("Pass runAt or cron, not both.");
  if (runAt !== undefined) {
    if (input.timezone !== undefined) throw invalid("timezone applies to cron only.");
    return { type: "once", runAt };
  }
  if (cron !== undefined) {
    const timezone =
      typeof input.timezone === "string"
        ? input.timezone
        : Intl.DateTimeFormat().resolvedOptions().timeZone;
    return { type: "cron", expression: cron, timezone };
  }
  if (input.timezone !== undefined) throw invalid("timezone requires cron.");
  return undefined;
}

/** Tool input minus routing fields, with runAt/cron/timezone folded into a schedule. */
function scheduledTaskFields(input: Record<string, unknown>): Record<string, unknown> {
  const {
    environmentId: _environmentId,
    runAt: _runAt,
    cron: _cron,
    timezone: _timezone,
    ...rest
  } = input;
  const schedule = scheduleFromInput(input);
  return { ...rest, ...(schedule === undefined ? {} : { schedule }) };
}

function environmentWithScopes(
  context: GatewayToolContext,
  input: Record<string, unknown>,
  requiredScopes: ReadonlyArray<GatewayScope>,
): string {
  const environmentId = requiredString(input, "environmentId");
  const scopes = currentGrants(context.grants)[environmentId];
  if (scopes === undefined) {
    throw new GatewayError({
      code: "unknown_environment",
      message: `Environment ${environmentId} is not granted to this host.`,
      retryable: false,
      environmentId,
    });
  }
  const missingScopes = requiredScopes.filter((scope) => !scopes.includes(scope));
  if (missingScopes.length > 0) {
    throw new GatewayError({
      code: "scope_required",
      message: `Scope ${missingScopes.join(" and ")} is required for environment ${environmentId}.`,
      retryable: false,
      environmentId,
      details: { requiredScopes, missingScopes, grantedScopes: scopes },
    });
  }
  return environmentId;
}

function environmentWithScope(
  context: GatewayToolContext,
  input: Record<string, unknown>,
  scope: GatewayScope,
): string {
  return environmentWithScopes(context, input, [scope]);
}

function environmentWithAnyScope(
  context: GatewayToolContext,
  input: Record<string, unknown>,
  acceptedScopes: ReadonlyArray<GatewayScope>,
): string {
  const environmentId = requiredString(input, "environmentId");
  const scopes = currentGrants(context.grants)[environmentId];
  if (scopes === undefined) {
    throw new GatewayError({
      code: "unknown_environment",
      message: `Environment ${environmentId} is not granted to this host.`,
      retryable: false,
      environmentId,
    });
  }
  if (!acceptedScopes.some((scope) => scopes.includes(scope))) {
    throw new GatewayError({
      code: "scope_required",
      message: `One of scopes ${acceptedScopes.join(" or ")} is required for environment ${environmentId}. The owner can enable Control active work for this machine in Settings → MCP Gateway and save. Default read/create/send access does not include thread control. No control command was dispatched.`,
      retryable: false,
      environmentId,
      details: {
        requiredScopes: acceptedScopes,
        scopeRequirement: "any",
        missingScopes: acceptedScopes,
        grantedScopes: scopes,
      },
    });
  }
  return environmentId;
}

interface DiscoveryTarget {
  readonly environmentId: string;
  readonly environmentLabel: string;
}

interface EnvironmentCoverage extends DiscoveryTarget {
  readonly connectionState: string;
  readonly status: "listed" | "skipped" | "failed";
  readonly reason?: string;
}

/**
 * Runs a read listing on the requested environment, or on every granted environment when
 * environmentId is omitted. Fan-out results come with coverage so a caller can tell an empty
 * machine from one that was disconnected, lacked read access, or failed.
 */
async function discover<T>(
  context: GatewayToolContext,
  input: Record<string, unknown>,
  list: (target: DiscoveryTarget) => Promise<T>,
): Promise<{
  readonly results: ReadonlyArray<{ readonly target: DiscoveryTarget; readonly value: T }>;
  readonly coverage?: ReadonlyArray<EnvironmentCoverage>;
}> {
  if (input.environmentId !== undefined) {
    const environmentId = environmentWithScope(context, input, "read");
    const environments = await context.port.listEnvironments();
    const environmentLabel =
      environments.find((environment) => environment.environmentId === environmentId)?.label ??
      environmentId;
    const target = { environmentId, environmentLabel };
    return { results: [{ target, value: await list(target) }] };
  }
  const environments = await context.port.listEnvironments();
  const grants = currentGrants(context.grants);
  const outcomes = await Promise.all(
    environments
      .filter((environment) => grants[environment.environmentId] !== undefined)
      .map(
        async (
          environment,
        ): Promise<{
          readonly coverage: EnvironmentCoverage;
          readonly listed?: { readonly target: DiscoveryTarget; readonly value: T };
        }> => {
          const target = {
            environmentId: environment.environmentId,
            environmentLabel: environment.label,
          };
          const base = { ...target, connectionState: environment.connectionState };
          if (!grants[environment.environmentId]?.includes("read")) {
            return { coverage: { ...base, status: "skipped", reason: "read not granted" } };
          }
          if (environment.connectionState !== "connected") {
            return {
              coverage: { ...base, status: "skipped", reason: environment.connectionState },
            };
          }
          try {
            const value = await list(target);
            return { listed: { target, value }, coverage: { ...base, status: "listed" } };
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            return { coverage: { ...base, status: "failed", reason } };
          }
        },
      ),
  );
  return {
    results: outcomes.flatMap((outcome) => (outcome.listed === undefined ? [] : [outcome.listed])),
    coverage: outcomes.map((outcome) => outcome.coverage),
  };
}

/** Merges per-environment pages; a single-environment page keeps its own shape. */
function discoveredPage(
  discovered: Awaited<ReturnType<typeof discover<GatewayListPage>>>,
): GatewayListPage & { readonly environments?: ReadonlyArray<EnvironmentCoverage> } {
  const items = discovered.results.flatMap(({ value }) => value.items);
  if (discovered.coverage === undefined) return { ...discovered.results[0]!.value, items };
  return { items, environments: discovered.coverage, snapshotAt: "runtime" };
}

type GatewayListPage = {
  readonly items: ReadonlyArray<Record<string, unknown>>;
  readonly nextCursor?: string;
  readonly snapshotAt: string;
};

function tagged(target: DiscoveryTarget, page: GatewayListPage): GatewayListPage {
  return { ...page, items: page.items.map((item) => ({ ...item, ...target })) };
}

type ThreadListFilter = ReturnType<typeof parseThreadListFilter>;

/** Rows sort newest update first; environment and id break ties so pages never overlap. */
type ThreadListKey = readonly [updatedAt: number, environmentId: string, id: string];

function threadListKey(row: Record<string, unknown>): ThreadListKey {
  const updatedAt = typeof row.updatedAt === "string" ? Date.parse(row.updatedAt) : Number.NaN;
  return [
    Number.isNaN(updatedAt) ? 0 : updatedAt,
    String(row.environmentId ?? ""),
    String(row.id ?? ""),
  ];
}

function compareThreadListKeys(a: ThreadListKey, b: ThreadListKey): number {
  if (a[0] !== b[0]) return b[0] - a[0];
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  return a[2] === b[2] ? 0 : a[2] < b[2] ? -1 : 1;
}

function encodeThreadListCursor(key: ThreadListKey): string {
  return Buffer.from(JSON.stringify(key)).toString("base64url");
}

function decodeThreadListCursor(cursor: string): ThreadListKey {
  let key: unknown;
  try {
    key = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    key = undefined;
  }
  if (
    !Array.isArray(key) ||
    key.length !== 3 ||
    typeof key[0] !== "number" ||
    typeof key[1] !== "string" ||
    typeof key[2] !== "string"
  ) {
    throw new GatewayError({
      code: "invalid_input",
      message: "cursor must be a nextCursor returned by t3_list_threads.",
      retryable: false,
    });
  }
  return [key[0], key[1], key[2]];
}

function parseThreadListFilter(input: Record<string, unknown>) {
  const parsed = z
    .object({
      state: z.enum(["all", "active", "settled"]).default("all"),
      projectId: z.string().optional(),
      profileId: z.string().optional(),
      parentThreadId: z.string().optional(),
      parentEnvironmentId: z.string().optional(),
      ...threadListWindowFields,
    })
    .safeParse(input);
  if (!parsed.success)
    throw new GatewayError({
      code: "invalid_input",
      message: parsed.error.message,
      retryable: false,
    });
  const { updatedAfter, updatedBefore, createdAfter, limit, cursor, ...rest } = parsed.data;
  const time = (value: string | undefined) => (value === undefined ? undefined : Date.parse(value));
  return {
    ...rest,
    executionState: parseExecutionStateFilter(input),
    updatedAfter: time(updatedAfter),
    updatedBefore: time(updatedBefore),
    createdAfter: time(createdAfter),
    limit: limit ?? THREAD_LIST_DEFAULT_LIMIT,
    after: cursor === undefined ? undefined : decodeThreadListCursor(cursor),
  };
}

function threadMatches(
  thread: Record<string, unknown>,
  environmentId: string,
  filter: ThreadListFilter,
): boolean {
  const snapshot = thread.profileSnapshot as { profileId?: string } | null | undefined;
  const updatedAt = typeof thread.updatedAt === "string" ? Date.parse(thread.updatedAt) : NaN;
  const createdAt = typeof thread.createdAt === "string" ? Date.parse(thread.createdAt) : NaN;
  return (
    (filter.projectId === undefined || thread.projectId === filter.projectId) &&
    (filter.parentThreadId === undefined ||
      (thread.parentThreadId === filter.parentThreadId &&
        (filter.parentEnvironmentId === undefined ||
          (thread.parentEnvironmentId ?? environmentId) === filter.parentEnvironmentId))) &&
    (filter.profileId === undefined || snapshot?.profileId === filter.profileId) &&
    (filter.state === "all" ||
      (filter.state === "settled" ? thread.settledAt != null : thread.settledAt == null)) &&
    (filter.executionState === undefined ||
      readThreadExecutionState(thread) === filter.executionState) &&
    (filter.updatedAfter === undefined || updatedAt >= filter.updatedAfter) &&
    (filter.updatedBefore === undefined || updatedAt < filter.updatedBefore) &&
    (filter.createdAfter === undefined || createdAt >= filter.createdAfter)
  );
}

/** A listing row: enough to pick a chat. t3_get_thread has the rest. */
function threadListRow(thread: Record<string, unknown>, target: DiscoveryTarget) {
  const profile = thread.profileSnapshot as
    | { profileId?: string | null; profileName?: string | null }
    | null
    | undefined;
  const model = thread.modelSelection as { instanceId?: string; model?: string } | null | undefined;
  return {
    id: thread.id,
    ...target,
    projectId: thread.projectId,
    title: thread.title,
    status: thread.status,
    hasPendingUserInput: thread.hasPendingUserInput,
    hasPendingApprovals: thread.hasPendingApprovals,
    profileId: profile?.profileId ?? null,
    profileName: profile?.profileName ?? null,
    providerInstanceId: model?.instanceId ?? null,
    model: model?.model ?? null,
    parentThreadId: thread.parentThreadId ?? null,
    parentEnvironmentId: thread.parentEnvironmentId ?? null,
    settledAt: thread.settledAt ?? null,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

/** One environment's matching rows past the cursor, newest first, at most one page plus one. */
async function listGatewayThreads(
  context: GatewayToolContext,
  target: DiscoveryTarget,
  filter: ThreadListFilter,
): Promise<GatewayListPage> {
  const page = await context.port.listThreads(target.environmentId);
  const rows = page.items
    .filter((thread) => threadMatches(thread, target.environmentId, filter))
    .map((thread) => threadListRow(thread, target))
    .filter(
      (row) =>
        filter.after === undefined || compareThreadListKeys(threadListKey(row), filter.after) > 0,
    )
    .sort((a, b) => compareThreadListKeys(threadListKey(a), threadListKey(b)));
  return { items: rows.slice(0, filter.limit + 1), snapshotAt: page.snapshotAt };
}

async function listThreadsPage(context: GatewayToolContext, input: Record<string, unknown>) {
  const filter = parseThreadListFilter(input);
  const discovered = await discover(context, input, (target) =>
    listGatewayThreads(context, target, filter),
  );
  const merged = discovered.results
    .flatMap(({ value }) => value.items)
    .sort((a, b) => compareThreadListKeys(threadListKey(a), threadListKey(b)));
  const rows = merged.slice(0, filter.limit);
  const hasMore = merged.length > filter.limit;
  const items =
    input.includeQuestions !== true
      ? rows
      : await Promise.all(
          // Only chats waiting on a question need a detail read; the rest pass through.
          rows.map(async (row) =>
            row.hasPendingUserInput === true &&
            typeof row.id === "string" &&
            typeof row.environmentId === "string"
              ? {
                  ...row,
                  pendingQuestions: pendingQuestionsOf(
                    await context.port.getThread(row.environmentId, row.id),
                  ),
                }
              : row,
          ),
        );
  return {
    items,
    hasMore,
    nextCursor: hasMore ? encodeThreadListCursor(threadListKey(rows.at(-1)!)) : null,
    ...(discovered.coverage === undefined
      ? { snapshotAt: discovered.results[0]!.value.snapshotAt }
      : { environments: discovered.coverage, snapshotAt: "runtime" }),
  };
}

async function agentsView(
  context: GatewayToolContext,
  target: DiscoveryTarget,
  input: Record<string, unknown>,
) {
  const { environmentId } = target;
  const { profileId, state } = z
    .object({
      profileId: z.string().trim().min(1).optional(),
      state: z.enum(["active", "settled", "all"]).default("active"),
    })
    .parse(input);
  const executionState = parseExecutionStateFilter(input);
  const [profiles, page] = await Promise.all([
    authoritativeProfiles(context, environmentId),
    context.port.listThreads(environmentId),
  ]);
  const runsByProfile = new Map<string, Record<string, unknown>[]>();
  for (const thread of page.items) {
    const snapshot = thread.profileSnapshot as { profileId?: string } | null | undefined;
    const agentId = snapshot?.profileId;
    if (!agentId || (profileId !== undefined && profileId !== agentId)) continue;
    if (
      state !== "all" &&
      (state === "settled" ? thread.settledAt == null : thread.settledAt != null)
    )
      continue;
    if (executionState !== undefined && readThreadExecutionState(thread) !== executionState)
      continue;
    const runs = runsByProfile.get(agentId) ?? [];
    runs.push({
      threadId: thread.id,
      ...target,
      projectId: thread.projectId,
      title: thread.title,
      status: thread.status,
      settledAt: thread.settledAt ?? null,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    });
    runsByProfile.set(agentId, runs);
  }
  const items = profiles
    .filter((profile) => profileId === undefined || profile.profileId === profileId)
    .map((profile) => {
      const runs = profile.profileId ? (runsByProfile.get(profile.profileId) ?? []) : [];
      if (profile.profileId) runsByProfile.delete(profile.profileId);
      return {
        profileId: profile.profileId,
        name: profile.name,
        description: profile.description ?? "",
        providerLabel: profile.providerLabel,
        modelLabel: profile.modelLabel,
        environmentIds: profile.environmentIds ?? [],
        runs,
      };
    });
  return {
    environmentId,
    items,
    orphanedRuns: [...runsByProfile].flatMap(([profileId, runs]) =>
      runs.map((run) => ({ ...run, profileId })),
    ),
    snapshotAt: page.snapshotAt,
  };
}

/** Profiles the shared library makes available on one environment. */
async function availableProfiles(context: GatewayToolContext, environmentId: string) {
  return (await authoritativeProfiles(context, environmentId)).filter(
    (profile) =>
      !Array.isArray(profile.environmentIds) ||
      profile.environmentIds.length === 0 ||
      profile.environmentIds.includes(environmentId),
  );
}

function idFor(kind: string, idempotencyKey: string): string {
  return `mcp-${kind}-${idempotencyKey}`;
}

function scopedIdFor(
  kind: string,
  environmentId: string,
  aggregateId: string,
  idempotencyKey: string,
): string {
  const digest = NodeCrypto.createHash("sha256")
    .update(stablePayload({ version: 2, environmentId, aggregateId, idempotencyKey }))
    .digest("hex");
  return `mcp-${kind}-v2-${digest}`;
}

function requireEventStore(context: GatewayToolContext): GatewayEventStore {
  if (context.events === undefined) {
    throw new GatewayError({
      code: "not_configured",
      message: "Event delivery is not configured for this gateway.",
      retryable: false,
    });
  }
  return context.events;
}

const EXECUTION_STATE_SET = new Set<string>(GATEWAY_THREAD_EXECUTION_STATES);

function readThreadExecutionState(
  thread: Record<string, unknown>,
): GatewayThreadExecutionState | undefined {
  const status = thread.status;
  return typeof status === "string" && EXECUTION_STATE_SET.has(status)
    ? (status as GatewayThreadExecutionState)
    : undefined;
}

function parseExecutionStateFilter(
  input: Record<string, unknown>,
): GatewayThreadExecutionState | undefined {
  const value = input.executionState;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !EXECUTION_STATE_SET.has(value)) {
    throw new GatewayError({
      code: "invalid_input",
      message: `executionState must be one of: ${GATEWAY_THREAD_EXECUTION_STATES.join(", ")}.`,
      retryable: false,
      details: { allowedExecutionStates: GATEWAY_THREAD_EXECUTION_STATES },
    });
  }
  return value as GatewayThreadExecutionState;
}

async function findGatewayThread(
  context: GatewayToolContext,
  environmentId: string,
  threadId: string,
): Promise<Record<string, unknown> | undefined> {
  const page = await context.port.listThreads(environmentId);
  return page.items.find(
    (candidate) => typeof candidate.id === "string" && candidate.id === threadId,
  );
}

/** Status hinted by a runtime event; undefined when the event carries no state. */
function gatewayEventExecutionState(event: GatewayEvent): GatewayThreadExecutionState | undefined {
  const status = event.data.status;
  if (typeof status === "string" && EXECUTION_STATE_SET.has(status)) {
    return status as GatewayThreadExecutionState;
  }
  switch (event.type) {
    case "thread.started":
      return "running";
    case "thread.completed":
      return "completed";
    case "thread.failed":
      return "failed";
    case "thread.interrupted":
      return "interrupted";
    case "approval.requested":
      return "waiting-approval";
    case "input.requested":
      return "waiting-input";
    default:
      return undefined;
  }
}

function boundedTimeoutMs(value: unknown, fallback: number): number {
  const requested = typeof value === "number" ? Math.trunc(value) : fallback;
  if (!Number.isFinite(requested)) return fallback;
  return Math.max(250, Math.min(120_000, requested));
}

function parseUntilStatuses(
  value: unknown,
): ReadonlyArray<GatewayThreadExecutionState> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new GatewayError({
      code: "invalid_input",
      message: "untilStatuses must be a non-empty array of execution states.",
      retryable: false,
    });
  }
  const parsed: GatewayThreadExecutionState[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "string" || !EXECUTION_STATE_SET.has(candidate)) {
      throw new GatewayError({
        code: "invalid_input",
        message: `untilStatuses must only contain: ${GATEWAY_THREAD_EXECUTION_STATES.join(", ")}.`,
        retryable: false,
        details: { allowedExecutionStates: GATEWAY_THREAD_EXECUTION_STATES },
      });
    }
    parsed.push(candidate as GatewayThreadExecutionState);
  }
  return parsed;
}

// Stable canonical JSON for idempotency payload comparison: unknown fields and
// key order must not turn a retry into a conflict.
function stablePayload(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stablePayload).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stablePayload(item)}`).join(",")}}`;
}

function isStaleApprovalFailure(payload: Record<string, unknown>): boolean {
  const detail = typeof payload.detail === "string" ? payload.detail.toLowerCase() : "";
  return (
    detail.includes("stale pending approval request") ||
    detail.includes("unknown pending approval request") ||
    detail.includes("unknown pending permission request")
  );
}

type PendingQuestion = {
  readonly questionId: string;
  readonly header: string;
  readonly question: string;
  readonly multiSelect: boolean;
  readonly allowsFreeText: boolean;
  readonly options: ReadonlyArray<{
    readonly label: string;
    readonly description: string;
    readonly value?: string;
  }>;
};
type PendingQuestionRequest = {
  readonly questionRequestId: string;
  readonly askedAt: string;
  readonly questions: ReadonlyArray<PendingQuestion>;
};

/** Questions the runtime projected onto a thread; empty for runtimes that predate them. */
function pendingQuestionsOf(
  thread: Record<string, unknown>,
): ReadonlyArray<PendingQuestionRequest> {
  return Array.isArray(thread.pendingQuestions)
    ? (thread.pendingQuestions as ReadonlyArray<PendingQuestionRequest>)
    : [];
}

type QuestionAnswerInput = {
  readonly questionId?: string | undefined;
  readonly options?: ReadonlyArray<string> | undefined;
  readonly text?: string | undefined;
};

function invalidAnswer(message: string, request: PendingQuestionRequest): GatewayError {
  return new GatewayError({
    code: "invalid_input",
    message,
    retryable: false,
    details: { questionRequestId: request.questionRequestId, questions: request.questions },
  });
}

/**
 * Turns chosen option labels or free text into the answers a provider expects:
 * each question id maps to its option value (the label when there is none),
 * a list of values for multi-select, or the text. Mirrors the composer's rules.
 */
export function resolveQuestionAnswers(
  request: PendingQuestionRequest,
  answers: ReadonlyArray<QuestionAnswerInput>,
): Record<string, string | ReadonlyArray<string>> {
  const resolved = new Map<string, string | ReadonlyArray<string>>();
  for (const answer of answers) {
    const question =
      answer.questionId === undefined
        ? request.questions.length === 1
          ? request.questions[0]
          : undefined
        : request.questions.find((candidate) => candidate.questionId === answer.questionId);
    if (question === undefined) {
      throw invalidAnswer(
        answer.questionId === undefined
          ? `This request asks ${request.questions.length} questions; pass questionId with each answer.`
          : `Question ${answer.questionId} is not part of this request.`,
        request,
      );
    }
    if (resolved.has(question.questionId)) {
      throw invalidAnswer(`"${question.header}" was answered more than once.`, request);
    }
    const text = answer.text?.trim() ?? "";
    const choices = answer.options ?? [];
    if (text !== "" && choices.length > 0) {
      throw invalidAnswer(
        `Answer "${question.header}" with options or with text, not both.`,
        request,
      );
    }
    if (text !== "") {
      if (!question.allowsFreeText) {
        throw invalidAnswer(`"${question.header}" only accepts one of its options.`, request);
      }
      resolved.set(question.questionId, text);
      continue;
    }
    if (choices.length === 0) {
      throw invalidAnswer(`Pass options or text for "${question.header}".`, request);
    }
    const values = [
      ...new Set(
        choices.map((choice) => {
          const wanted = choice.trim().toLocaleLowerCase();
          const option =
            question.options.find((candidate) => (candidate.value ?? candidate.label) === choice) ??
            question.options.find(
              (candidate) =>
                candidate.label.trim().toLocaleLowerCase() === wanted ||
                candidate.value?.trim().toLocaleLowerCase() === wanted,
            );
          if (option === undefined) {
            throw invalidAnswer(
              `"${choice}" is not an option for "${question.header}". Options: ${question.options.map((candidate) => candidate.label).join(", ")}.`,
              request,
            );
          }
          return option.value ?? option.label;
        }),
      ),
    ];
    if (!question.multiSelect && values.length !== 1) {
      throw invalidAnswer(`"${question.header}" takes exactly one option.`, request);
    }
    resolved.set(question.questionId, question.multiSelect ? values : values[0]!);
  }
  const missing = request.questions.filter((question) => !resolved.has(question.questionId));
  if (missing.length > 0) {
    throw invalidAnswer(
      `Answer every question in the request. Missing: ${missing.map((question) => question.header).join(", ")}.`,
      request,
    );
  }
  return Object.fromEntries(resolved);
}

function approvalAction(requestId: string, requestKind: string, detail: string | undefined) {
  return {
    approvalActionId: requestId,
    requestKind,
    detail: detail ?? "Approval requested",
    risk: requestKind === "file-read" ? "low" : "high",
    reversible: requestKind !== "command",
    requiresDestructiveConfirmation: requestKind === "command" || requestKind === "file-change",
    modifiableFields: ["decision"],
  };
}

function approvalPlan(thread: Record<string, unknown>) {
  const threadId = typeof thread.id === "string" ? thread.id : "unknown";
  // V2 runtimes list pending approvals directly; older runtimes only expose activities.
  if (Array.isArray(thread.pendingApprovals)) {
    const actions = thread.pendingApprovals.flatMap((candidate) => {
      if (typeof candidate !== "object" || candidate === null) return [];
      const approval = candidate as Record<string, unknown>;
      if (typeof approval.requestId !== "string") return [];
      return [
        approvalAction(
          approval.requestId,
          typeof approval.requestKind === "string" ? approval.requestKind : "command",
          typeof approval.detail === "string" ? approval.detail : undefined,
        ),
      ];
    });
    return { approvalPlanId: `plan-${threadId}`, revision: 0, actions };
  }
  const pending = new Map<string, Record<string, unknown>>();
  const activities = (Array.isArray(thread.activities) ? thread.activities : []).toSorted(
    (left, right) => {
      const leftSequence =
        typeof left === "object" && left !== null && "sequence" in left ? Number(left.sequence) : 0;
      const rightSequence =
        typeof right === "object" && right !== null && "sequence" in right
          ? Number(right.sequence)
          : 0;
      return leftSequence - rightSequence;
    },
  );
  let revision = 0;
  for (const candidate of activities) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
    const activity = candidate as Record<string, unknown>;
    const payload =
      typeof activity.payload === "object" &&
      activity.payload !== null &&
      !Array.isArray(activity.payload)
        ? (activity.payload as Record<string, unknown>)
        : {};
    const requestId = typeof payload.requestId === "string" ? payload.requestId : undefined;
    if (typeof activity.sequence === "number") revision = Math.max(revision, activity.sequence);
    if (requestId === undefined) continue;
    if (activity.kind === "approval.requested") {
      pending.set(
        requestId,
        approvalAction(
          requestId,
          typeof payload.requestKind === "string" ? payload.requestKind : "command",
          typeof payload.detail === "string" ? payload.detail : undefined,
        ),
      );
    } else if (activity.kind === "approval.resolved") {
      pending.delete(requestId);
    } else if (
      activity.kind === "provider.approval.respond.failed" &&
      isStaleApprovalFailure(payload)
    ) {
      pending.delete(requestId);
    }
  }
  return {
    approvalPlanId: `plan-${threadId}`,
    revision,
    actions: [...pending.values()],
  };
}

function pullRequestRef(input: Record<string, unknown>) {
  const number = Number(input.number);
  if (!Number.isInteger(number) || number < 1) {
    throw new GatewayError({
      code: "invalid_input",
      message: "number must be a positive integer.",
      retryable: false,
    });
  }
  return {
    projectId: requiredString(input, "projectId"),
    repository: requiredString(input, "repository"),
    number,
  };
}

function assertRepositoryAllowed(
  context: GatewayToolContext,
  environmentId: string,
  owner: string,
  repository: string,
): void {
  const identity = `${owner}/${repository}`.toLowerCase();
  const allowlist = context.repositoryAllowlist ?? ["jayleaton/t3code"];
  if (!allowlist.some((candidate) => candidate.toLowerCase() === identity)) {
    throw new GatewayError({
      code: "scope_required",
      message: `Repository ${identity} is outside the configured write allowlist.`,
      retryable: false,
      environmentId,
      details: { repository: identity, permission: "repository-allowlist" },
    });
  }
}

async function assertProjectRepositoryAllowed(
  context: GatewayToolContext,
  environmentId: string,
  input: Record<string, unknown>,
): Promise<void> {
  const projectId = requiredString(input, "projectId");
  const projects = await context.port.listProjects(environmentId);
  const project = projects.items.find((candidate) => candidate.id === projectId);
  const identity =
    typeof project?.repositoryIdentity === "object" && project.repositoryIdentity !== null
      ? (project.repositoryIdentity as Record<string, unknown>)
      : undefined;
  if (typeof identity?.owner !== "string" || typeof identity.name !== "string") {
    throw new GatewayError({
      code: "invalid_input",
      message: `Project ${projectId} has no authoritative repository identity.`,
      retryable: false,
      environmentId,
    });
  }
  const requestedOwner = typeof input.owner === "string" ? input.owner : identity.owner;
  const rawRepository = typeof input.repository === "string" ? input.repository : identity.name;
  const requestedRepository = rawRepository.includes("/")
    ? (rawRepository.split("/", 2)[1] ?? "")
    : rawRepository;
  const qualifiedOwner = rawRepository.includes("/")
    ? (rawRepository.split("/", 2)[0] ?? "")
    : requestedOwner;
  if (
    qualifiedOwner !== identity.owner ||
    requestedRepository !== identity.name ||
    requestedOwner !== identity.owner
  ) {
    throw new GatewayError({
      code: "invalid_input",
      message: "Repository target does not match the selected project identity.",
      retryable: false,
      environmentId,
    });
  }
  assertRepositoryAllowed(context, environmentId, identity.owner, identity.name);
}

function requiredIdempotencyKey(input: Record<string, unknown>): string {
  return requiredString(input, "idempotencyKey");
}

function idempotencyCommandPayload(operation: string, input: Record<string, unknown>) {
  return { operation, input };
}

const pendingRequests = new WeakMap<GatewayEventStore, Map<string, Promise<unknown>>>();

// Memoizes a mutating command per (environmentId, threadId, requestId). On a
// first attempt it runs the operation and stores the receipt; a same-payload
// retry replays the stored receipt; a different payload is idempotency_conflict.
async function withIdempotency<Prepared = undefined>(
  context: GatewayToolContext,
  key: string,
  payload: unknown,
  operation: (prepared: Prepared | undefined) => Promise<unknown>,
  prepare?: () => Promise<Prepared> | Prepared,
): Promise<unknown> {
  // Additive v3 behavior: without an event store the command runs directly,
  // preserving the v1 single-shot semantics.
  if (context.events === undefined) {
    const prepared = prepare === undefined ? undefined : await prepare();
    return operation(prepared);
  }
  const events = context.events;
  let pending = pendingRequests.get(events);
  if (pending === undefined) {
    pending = new Map();
    pendingRequests.set(events, pending);
  }
  const canonical = stablePayload(payload);
  const outcome = events.rememberRequest(key, canonical, null);
  if (outcome === "conflict") {
    throw new GatewayError({
      code: "idempotency_conflict",
      message: "This request id was already used with a different payload.",
      retryable: false,
      requestId: key,
    });
  }
  if (outcome === "duplicate") {
    const previous = events.recallRequest(key);
    if (previous !== undefined && previous !== null) return previous;
    const active = pending.get(key);
    if (active !== undefined) return active;
  }
  const recovering = outcome === "duplicate" && events.requestState(key) === "dispatched";
  // Start on the next microtask so the Promise is visible to same-process
  // duplicates before validation or dispatch can yield.
  const execution = Promise.resolve().then(async () => {
    let prepared: Prepared | undefined;
    if (recovering) {
      prepared = events.recallDispatchContext<Prepared>(key);
    } else {
      try {
        prepared = prepare === undefined ? undefined : await prepare();
      } catch (error) {
        // A failed pre-dispatch check must not leave an ambiguous null receipt
        // that a later retry could mistake for an authoritative dispatch.
        events.forgetRequest(key);
        throw error;
      }
      events.markRequestDispatched(key, prepared);
    }
    const result = await operation(prepared);
    events.completeRequest(key, result);
    return result;
  });
  pending.set(key, execution);
  try {
    return await execution;
  } finally {
    pending.delete(key);
  }
}

async function assertRecoverableHistoricalSend(
  context: GatewayToolContext,
  key: string,
  environmentId: string,
  threadId: string,
  currentRequestId: string,
  historicalRequestIds: ReadonlyArray<string>,
): Promise<void> {
  const events = context.events;
  if (events === undefined) return;
  const state = events.requestState(key);
  if (state !== "dispatched" && state !== "completed") return;
  const stored =
    state === "completed"
      ? events.recallRequest<Record<string, unknown>>(key)
      : events.recallDispatchContext<Record<string, unknown>>(key);
  const requestId =
    typeof stored?.requestId === "string"
      ? stored.requestId
      : typeof stored?.commandId === "string"
        ? stored.commandId
        : undefined;
  if (requestId === currentRequestId) return;
  if (requestId === undefined || !historicalRequestIds.includes(requestId)) {
    throw new GatewayError({
      code: "idempotency_conflict",
      message: "This send has no recoverable authoritative command identity.",
      retryable: false,
      environmentId,
      requestId: currentRequestId,
      details: { threadId },
    });
  }
  const messageId = typeof stored?.messageId === "string" ? stored.messageId : undefined;
  if (messageId === undefined || context.port.hasThreadMessage === undefined) {
    throw new GatewayError({
      code: "idempotency_conflict",
      message:
        "This historical send receipt cannot be verified until the connected runtime supports authoritative message lookup.",
      retryable: false,
      environmentId,
      requestId,
      details: { threadId, messageId },
    });
  }
  const messageExists = await context.port.hasThreadMessage(environmentId, threadId, messageId);
  if (!messageExists) {
    throw new GatewayError({
      code: "idempotency_conflict",
      message:
        "This historical send receipt cannot be proven to have created its message; refusing an ambiguous replay.",
      retryable: false,
      environmentId,
      requestId,
      details: { threadId, messageId },
    });
  }
}

/**
 * A thread read whose failure is checked against the environment's thread list. A snapshot
 * error does not say whether the thread exists, and relays pass errors on only as text.
 */
async function getThreadOrNotFound(
  context: GatewayToolContext,
  environmentId: string,
  threadId: string,
) {
  try {
    return await context.port.getThread(environmentId, threadId);
  } catch (error) {
    const listed = await context.port.listThreads(environmentId).catch(() => undefined);
    if (listed === undefined || listed.items.some((thread) => thread.id === threadId)) throw error;
    throw new GatewayError({
      code: "thread_not_found",
      message: `Thread ${threadId} was not found on environment ${environmentId}. Pass the full threadId as t3_list_threads returns it.`,
      retryable: false,
      environmentId,
    });
  }
}

function requireOperationPort(context: GatewayToolContext) {
  if (context.port.executeOperation === undefined) {
    throw new GatewayError({
      code: "not_configured",
      message: "The connected runtime does not support this v3 operation.",
      retryable: false,
    });
  }
  return context.port.executeOperation.bind(context.port);
}

function assertPatchPathsAreProjectRelative(patch: string) {
  const paths = patch
    .split("\n")
    .filter((line) => line.startsWith("--- ") || line.startsWith("+++ "))
    .map((line) => line.slice(4).split("\t", 1)[0] ?? "")
    .filter((path) => path !== "/dev/null")
    .map((path) => (path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path));
  if (
    paths.length === 0 ||
    paths.some(
      (path) =>
        path === "" || path.startsWith("/") || path.split("/").some((segment) => segment === ".."),
    )
  ) {
    throw new GatewayError({
      code: "invalid_input",
      message: "Patch paths must remain inside the selected project root.",
      retryable: false,
    });
  }
}

/** Surfaces a task error's code and detail, whether it arrives bare or wrapped in a cause. */
function threadTaskFailure(error: unknown, environmentId: string): unknown {
  for (
    let current = error, depth = 0;
    depth < 4 && typeof current === "object" && current;
    depth++
  ) {
    const candidate = current as {
      _tag?: unknown;
      code?: unknown;
      detail?: unknown;
      cause?: unknown;
    };
    if (
      candidate._tag === "ThreadTaskError" &&
      typeof candidate.code === "string" &&
      typeof candidate.detail === "string"
    ) {
      const { currentRevision } = current as { currentRevision?: unknown };
      return new GatewayError({
        code: "upstream_failure",
        message: `${candidate.code}: ${candidate.detail}`,
        retryable: false,
        environmentId,
        details: {
          taskErrorCode: candidate.code,
          detail: candidate.detail,
          ...(typeof currentRevision === "number" ? { currentRevision } : {}),
        },
      });
    }
    current = candidate.cause;
  }
  return error;
}

export async function callGatewayTool(
  context: GatewayToolContext,
  name: string,
  rawInput: unknown,
  invocation: GatewayInvocation = {},
): Promise<any> {
  const input = record(rawInput);
  switch (name) {
    case "t3_list_environments": {
      const environments = await context.port.listEnvironments();
      const grants = currentGrants(context.grants);
      return {
        items: environments
          .filter((environment) => grants[environment.environmentId] !== undefined)
          .map((environment) => ({
            ...environment,
            grantedScopes: grants[environment.environmentId],
          })),
        snapshotAt: "runtime",
      };
    }
    case "t3_get_environment_status": {
      const environmentId = environmentWithScope(context, input, "read");
      return context.port.getEnvironmentStatus(environmentId);
    }
    case "t3_get_presence": {
      const environmentId = environmentWithScope(context, input, "read");
      if (context.port.getPresence === undefined) {
        throw new Error("Presence is unavailable from this T3 host.");
      }
      return context.port.getPresence(environmentId);
    }
    case "t3_get_environment_health": {
      const environmentId = environmentWithScope(context, input, "read");
      const status = await context.port.getEnvironmentStatus(environmentId);
      const phase = typeof status.phase === "string" ? status.phase : status.connectionState;
      return {
        environmentId,
        phase,
        health:
          phase === "connected"
            ? "healthy"
            : phase === "connecting"
              ? "connecting"
              : "disconnected",
        providerRuntimeReady: phase === "connected",
        eventStreamReady: context.events !== undefined && phase === "connected",
        artifactStoreReady: phase === "connected",
        degradedReasons:
          phase === "connected" ? [] : [String(status.lastFailure ?? phase ?? "unavailable")],
        snapshotAt: "runtime",
      };
    }
    case "t3_get_gateway_health": {
      const grants = currentGrants(context.grants);
      const runtimeHealth = context.health?.() ?? {
        bridge: "connected" as const,
        degradedReasons: [] as ReadonlyArray<string>,
      };
      const deliveryFailures = context.events?.deliveryFailureSummary(Object.keys(grants)) ?? {
        count: 0,
        recent: [],
      };
      const health =
        runtimeHealth.bridge === "connected" && deliveryFailures.count === 0
          ? "healthy"
          : "degraded";
      return {
        health,
        mcpTransport: "connected",
        bridge: runtimeHealth.bridge,
        eventStore:
          context.events === undefined
            ? "not-configured"
            : deliveryFailures.count === 0
              ? "ready"
              : "degraded",
        environmentCount: Object.keys(grants).length,
        latestSequenceByEnvironment:
          context.events === undefined
            ? {}
            : Object.fromEntries(
                Object.keys(grants).map((id) => [id, context.events?.latestSequence(id) ?? 0]),
              ),
        deliveryFailureCount: deliveryFailures.count,
        degradedReasons: [
          ...runtimeHealth.degradedReasons,
          ...deliveryFailures.recent.map(
            (failure) =>
              `Webhook ${failure.webhookId} failed after ${failure.attempts} attempts: ${failure.error.slice(0, 500)}`,
          ),
        ],
        clock: "runtime",
      };
    }
    case "t3_handoff_thread": {
      const parsed = handoffInputSchema.parse(input);
      environmentWithScopes(context, parsed, ["create", "send", "artifact"]);
      environmentWithScopes(
        context,
        { environmentId: parsed.sourceEnvironmentId },
        parsed.files?.length ? ["read", "artifact"] : ["read"],
      );
      if (!context.port.handoffThread)
        throw new Error("Agent handoff is unavailable in this runtime.");
      return context.port.handoffThread(parsed);
    }
    case "t3_settle_thread": {
      const environmentId = environmentWithScope(context, input, "lifecycle");
      if (input.confirmed !== true)
        throw new Error("Ask the user before settling the source conversation.");
      if (!context.port.settleThread)
        throw new Error("Thread settlement is unavailable in this runtime.");
      return context.port.settleThread(environmentId, requiredString(input, "threadId"));
    }
    case "t3_unsettle_thread": {
      const environmentId = environmentWithScope(context, input, "lifecycle");
      if (!context.port.unsettleThread)
        throw new Error("Thread un-settlement is unavailable in this runtime.");
      return context.port.unsettleThread(environmentId, requiredString(input, "threadId"));
    }
    case "t3_set_thread_parent": {
      const environmentId = environmentWithScope(context, input, "lifecycle");
      if (!context.port.setThreadParent)
        throw new Error("Linking chats is unavailable in this runtime.");
      const parentThreadId =
        input.parentThreadId === null ? null : requiredString(input, "parentThreadId");
      const parentEnvironmentId =
        typeof input.parentEnvironmentId === "string" ? input.parentEnvironmentId : undefined;
      return context.port.setThreadParent(
        environmentId,
        requiredString(input, "threadId"),
        parentThreadId,
        ...(parentEnvironmentId === undefined ? [] : [parentEnvironmentId]),
      );
    }
    case "t3_list_skills": {
      const environmentId = environmentWithScope(context, input, "read");
      if (!context.port.listSkills)
        throw new Error("Shared skills are unavailable in this runtime. Update T3.");
      return { items: await context.port.listSkills(environmentId) };
    }
    case "t3_create_skill":
    case "t3_update_skill": {
      const environmentId = environmentWithAnyScope(context, input, ["create", "admin"]);
      const parsed = (
        name === "t3_create_skill" ? skillInput : skillInput.partial().strict()
      ).safeParse(name === "t3_create_skill" ? input : input.patch);
      if (!parsed.success)
        throw new GatewayError({
          code: "invalid_input",
          message: parsed.error.message,
          retryable: false,
        });
      let skill;
      if (name === "t3_create_skill") {
        if (!context.port.createSkill)
          throw new Error("Shared skills are unavailable in this runtime. Update T3.");
        skill = await context.port.createSkill(environmentId, skillInput.parse(parsed.data));
      } else {
        if (!context.port.updateSkill)
          throw new Error("Shared skills are unavailable in this runtime. Update T3.");
        skill = await context.port.updateSkill(
          environmentId,
          requiredString(input, "skillId"),
          parsed.data,
        );
      }
      return { skill, sync: await shareSkills(context, environmentId) };
    }
    case "t3_delete_skill": {
      const environmentId = environmentWithAnyScope(context, input, ["create", "admin"]);
      if (!context.port.deleteSkill)
        throw new Error("Shared skills are unavailable in this runtime. Update T3.");
      const result = await context.port.deleteSkill(
        environmentId,
        requiredString(input, "skillId"),
      );
      return { ...result, sync: await shareSkills(context, environmentId) };
    }
    case "t3_create_agent": {
      const environmentId = environmentWithAnyScope(context, input, ["create", "admin"]);
      if (!context.port.createProfile)
        throw new Error("Profile creation is unavailable in this runtime.");
      const parsed = profileInput.safeParse(input);
      if (!parsed.success)
        throw new GatewayError({
          code: "invalid_input",
          message: parsed.error.message,
          retryable: false,
        });
      const profile = await context.port.createProfile(environmentId, parsed.data);
      return { profile, sync: await shareProfiles(context, environmentId) };
    }
    case "t3_update_agent": {
      const environmentId = environmentWithAnyScope(context, input, ["create", "admin"]);
      if (!context.port.updateProfile)
        throw new Error("Profile editing is unavailable in this runtime.");
      const parsed = profileInput.partial().strict().safeParse(input.patch);
      if (!parsed.success)
        throw new GatewayError({
          code: "invalid_input",
          message: parsed.error.message,
          retryable: false,
        });
      const profile = await context.port.updateProfile(
        environmentId,
        requiredString(input, "profileId"),
        parsed.data,
      );
      return { profile, sync: await shareProfiles(context, environmentId) };
    }
    case "t3_delete_agent": {
      const environmentId = environmentWithAnyScope(context, input, ["create", "admin"]);
      if (!context.port.deleteProfile)
        throw new Error("Profile deletion is unavailable in this runtime.");
      const result = await context.port.deleteProfile(
        environmentId,
        requiredString(input, "profileId"),
      );
      return {
        ...result,
        sync: await shareProfiles(
          context,
          environmentId,
          result.deletedAt ? { [result.profileId]: result.deletedAt } : undefined,
        ),
      };
    }
    case "t3_open_agents": {
      const environmentId = environmentWithScope(context, input, "read");
      if (!context.port.openAgents) throw new Error("Desktop agents navigation is unavailable.");
      return context.port.openAgents(environmentId);
    }
    case "t3_list_projects": {
      return discoveredPage(
        await discover(context, input, async (target) =>
          tagged(target, await context.port.listProjects(target.environmentId)),
        ),
      );
    }
    case "t3_list_threads":
      return listThreadsPage(context, input);
    case "t3_list_devices": {
      const environmentId = environmentWithScope(context, input, "read");
      if (!context.port.listDevices)
        throw new Error("Device focus is unavailable in this runtime. Update T3.");
      return { items: await context.port.listDevices(environmentId) };
    }
    case "t3_focus_device": {
      const environmentId = environmentWithScope(context, input, "read");
      if (!context.port.focusDevice)
        throw new Error("Device focus is unavailable in this runtime. Update T3.");
      return context.port.focusDevice(
        environmentId,
        requiredString(input, "device"),
        focusTargetFromInput(input),
      );
    }
    case "t3_list_scheduled_tasks": {
      const environmentId = environmentWithScope(context, input, "read");
      if (!context.port.scheduledTask)
        throw new Error("Scheduled tasks are unavailable in this runtime. Update T3.");
      return context.port.scheduledTask(environmentId, { action: "list" });
    }
    case "t3_create_scheduled_task": {
      const environmentId = environmentWithAnyScope(context, input, ["create", "admin"]);
      if (!context.port.scheduledTask)
        throw new Error("Scheduled tasks are unavailable in this runtime. Update T3.");
      const fields = scheduledTaskFields(input);
      if (!("schedule" in fields)) {
        throw new GatewayError({
          code: "invalid_input",
          message: "Pass runAt for a one-time task or cron for a recurring one.",
          retryable: false,
        });
      }
      return context.port.scheduledTask(environmentId, {
        action: "create",
        input: fields as unknown as GatewayScheduledTaskCreate,
      });
    }
    case "t3_update_scheduled_task": {
      const environmentId = environmentWithAnyScope(context, input, ["create", "admin"]);
      if (!context.port.scheduledTask)
        throw new Error("Scheduled tasks are unavailable in this runtime. Update T3.");
      const patch =
        typeof input.patch === "object" && input.patch !== null
          ? (input.patch as Record<string, unknown>)
          : {};
      return context.port.scheduledTask(environmentId, {
        action: "update",
        taskId: requiredString(input, "taskId"),
        patch: scheduledTaskFields(patch) as GatewayScheduledTaskPatch,
      });
    }
    case "t3_delete_scheduled_task": {
      const environmentId = environmentWithAnyScope(context, input, ["create", "admin"]);
      if (!context.port.scheduledTask)
        throw new Error("Scheduled tasks are unavailable in this runtime. Update T3.");
      return context.port.scheduledTask(environmentId, {
        action: "delete",
        taskId: requiredString(input, "taskId"),
      });
    }
    case "t3_run_scheduled_task": {
      const environmentId = environmentWithScope(context, input, "send");
      if (!context.port.scheduledTask)
        throw new Error("Scheduled tasks are unavailable in this runtime. Update T3.");
      return context.port.scheduledTask(environmentId, {
        action: "run",
        taskId: requiredString(input, "taskId"),
      });
    }
    case "t3_list_todos": {
      const environmentId = environmentWithScope(context, input, "read");
      if (!context.port.todo) throw new Error("Todos are unavailable in this runtime. Update T3.");
      return context.port.todo(environmentId, {
        action: "list",
        projectId: requiredString(input, "projectId"),
      });
    }
    case "t3_add_todo": {
      const environmentId = environmentWithAnyScope(context, input, ["create", "admin"]);
      if (!context.port.todo) throw new Error("Todos are unavailable in this runtime. Update T3.");
      return context.port.todo(environmentId, {
        action: "add",
        projectId: requiredString(input, "projectId"),
        text: requiredString(input, "text"),
      });
    }
    case "t3_update_todo": {
      const environmentId = environmentWithAnyScope(context, input, ["create", "admin"]);
      if (!context.port.todo) throw new Error("Todos are unavailable in this runtime. Update T3.");
      return context.port.todo(environmentId, {
        action: "update",
        todoId: requiredString(input, "todoId"),
        text: requiredString(input, "text"),
      });
    }
    case "t3_settle_todo":
    case "t3_unsettle_todo":
    case "t3_remove_todo": {
      const environmentId = environmentWithAnyScope(context, input, ["create", "admin"]);
      if (!context.port.todo) throw new Error("Todos are unavailable in this runtime. Update T3.");
      return context.port.todo(environmentId, {
        action:
          name === "t3_settle_todo"
            ? "settle"
            : name === "t3_unsettle_todo"
              ? "unsettle"
              : "remove",
        todoId: requiredString(input, "todoId"),
      });
    }
    case "t3_task_assign":
    case "t3_task_read":
    case "t3_task_update":
    case "t3_task_watch":
    case "t3_task_board":
    case "t3_settle_after_turn": {
      const action =
        name === "t3_task_assign"
          ? "assign"
          : name === "t3_task_read"
            ? "read"
            : name === "t3_task_update"
              ? "update"
              : name === "t3_task_watch"
                ? "watch"
                : name === "t3_task_board"
                  ? "board"
                  : "settleAfterTurn";
      const environmentId =
        action === "read" || action === "watch" || action === "board"
          ? environmentWithScope(context, input, "read")
          : action === "settleAfterTurn"
            ? environmentWithScope(context, input, "lifecycle")
            : environmentWithAnyScope(context, input, ["create", "admin"]);
      if (!context.port.threadTask)
        throw new Error("Thread tasks are unavailable in this runtime. Update T3.");
      const { environmentId: _environmentId, requestId: _r, correlationId: _c, ...fields } = input;
      const parsed = z.strictObject(threadTaskInputFields[action]).safeParse(fields);
      if (!parsed.success) {
        throw new GatewayError({
          code: "invalid_input",
          message: parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
            .join("; "),
          retryable: false,
          environmentId,
        });
      }
      const request = { action, input: parsed.data } as GatewayThreadTaskRequest;
      try {
        // The calling chat is the server's own record of who invoked the tool, never input.
        return await context.port.threadTask(environmentId, request, invocation.caller);
      } catch (error) {
        throw threadTaskFailure(error, environmentId);
      }
    }
    case "t3_open_thread": {
      const environmentId = environmentWithScope(context, input, "read");
      return context.port.openThread(environmentId, requiredString(input, "threadId"));
    }
    case "t3_get_thread": {
      const environmentId = environmentWithScope(context, input, "read");
      return getThreadOrNotFound(context, environmentId, requiredString(input, "threadId"));
    }
    case "t3_summarize_thread": {
      const environmentId = environmentWithScope(context, input, "read");
      const thread = await getThreadOrNotFound(
        context,
        environmentId,
        requiredString(input, "threadId"),
      );
      const plan = approvalPlan(thread);
      const pendingQuestions = pendingQuestionsOf(thread);
      const session =
        typeof thread.session === "object" && thread.session !== null
          ? (thread.session as Record<string, unknown>)
          : null;
      const latestTurn =
        typeof thread.latestTurn === "object" && thread.latestTurn !== null
          ? (thread.latestTurn as Record<string, unknown>)
          : null;
      const status =
        thread.settledAt != null
          ? "settled"
          : plan.actions.length > 0
            ? "waiting-approval"
            : pendingQuestions.length > 0
              ? "waiting-input"
              : typeof thread.status === "string"
                ? thread.status
                : typeof latestTurn?.state === "string"
                  ? latestTurn.state
                  : typeof session?.status === "string"
                    ? session.status
                    : "queued";
      return {
        environmentId,
        threadId: thread.id,
        title: thread.title,
        status,
        summary: session?.lastError ?? `Thread is ${status}.`,
        blockers: plan.actions,
        approvalPlan: plan,
        pendingQuestions,
        artifacts: Array.isArray(thread.artifacts) ? thread.artifacts : [],
        nextAction:
          plan.actions.length > 0
            ? "approve_actions"
            : pendingQuestions.length > 0
              ? "provide_input"
              : status === "running" || status === "queued"
                ? "await_event"
                : null,
        snapshotAt: thread.updatedAt ?? "runtime",
      };
    }
    case "t3_get_agents_view": {
      // Validate filters once so a bad input fails the call instead of every environment.
      z.enum(["active", "settled", "all"]).optional().parse(input.state);
      parseExecutionStateFilter(input);
      const discovered = await discover(context, input, (target) =>
        agentsView(context, target, input),
      );
      if (discovered.coverage === undefined) return discovered.results[0]!.value;
      // The Agents library is shared, so one card per agent collects its runs from every machine.
      const cards = new Map<string, Awaited<ReturnType<typeof agentsView>>["items"][number]>();
      for (const { value } of discovered.results) {
        for (const card of value.items) {
          const key = card.profileId ?? card.name;
          const existing = cards.get(key);
          cards.set(key, existing ? { ...existing, runs: [...existing.runs, ...card.runs] } : card);
        }
      }
      return {
        items: [...cards.values()],
        orphanedRuns: discovered.results.flatMap(({ value }) => value.orphanedRuns),
        environments: discovered.coverage,
        snapshotAt: "runtime",
      };
    }
    case "t3_list_agents": {
      const includeSystemPrompt = input.includeSystemPrompt === true;
      const discovered = await discover(context, input, async (target) =>
        (await availableProfiles(context, target.environmentId)).map((profile) => {
          if (includeSystemPrompt) return profile;
          const { systemPrompt: _systemPrompt, ...rest } = profile;
          return rest;
        }),
      );
      if (discovered.coverage === undefined) {
        return { items: discovered.results[0]!.value, snapshotAt: "runtime" };
      }
      // One entry per shared agent, listing the machines it is available on.
      const agents = new Map<string, GatewayProfile & { availableEnvironmentIds: string[] }>();
      for (const { target, value } of discovered.results) {
        for (const profile of value) {
          const key = profile.profileId ?? profile.name;
          const existing = agents.get(key);
          if (existing) existing.availableEnvironmentIds.push(target.environmentId);
          else agents.set(key, { ...profile, availableEnvironmentIds: [target.environmentId] });
        }
      }
      return {
        items: [...agents.values()],
        environments: discovered.coverage,
        snapshotAt: "runtime",
      };
    }
    case "t3_get_messages": {
      const environmentId = environmentWithScope(context, input, "read");
      const thread = await getThreadOrNotFound(
        context,
        environmentId,
        requiredString(input, "threadId"),
      );
      const messages = Array.isArray(thread.messages) ? thread.messages : [];
      const requestedLimit = typeof input.limit === "number" ? input.limit : 100;
      const limit = Math.max(1, Math.min(100, Math.trunc(requestedLimit)));
      return {
        items: messages.slice(-limit),
        snapshotAt: typeof thread.updatedAt === "string" ? thread.updatedAt : "runtime",
      };
    }
    case "t3_get_operation_history": {
      const events = requireEventStore(context);
      const environmentId = environmentWithScope(context, input, "read");
      const afterSequence =
        typeof input.afterSequence === "number" ? Math.max(0, Math.trunc(input.afterSequence)) : 0;
      const limit =
        typeof input.limit === "number" ? Math.max(1, Math.min(500, Math.trunc(input.limit))) : 200;
      const items = events.operationHistory(
        environmentId,
        afterSequence,
        limit,
        typeof input.threadId === "string" ? input.threadId : undefined,
      );
      return {
        items,
        ...(items.at(-1) === undefined ? {} : { nextCursor: String(items.at(-1)?.sequence) }),
        hasMore: items.length === limit,
      };
    }
    case "t3_get_pr": {
      const environmentId = environmentWithScope(context, input, "review");
      return context.port.getPullRequest(environmentId, pullRequestRef(input));
    }
    case "t3_get_pr_checks": {
      const environmentId = environmentWithScope(context, input, "review");
      const detail = await context.port.getPullRequest(environmentId, pullRequestRef(input));
      return { items: Array.isArray(detail.checks) ? detail.checks : [] };
    }
    case "t3_list_review_comments": {
      const environmentId = environmentWithScope(context, input, "review");
      const activity = await context.port.getPullRequestActivity(
        environmentId,
        pullRequestRef(input),
      );
      const items = (Array.isArray(activity.reviewThreads) ? activity.reviewThreads : []).filter(
        (thread): thread is Record<string, unknown> =>
          typeof thread === "object" &&
          thread !== null &&
          !Array.isArray(thread) &&
          (thread as Record<string, unknown>).isResolved !== true,
      );
      return { items, unresolvedCount: items.length };
    }
    case "t3_replay_events": {
      const events = requireEventStore(context);
      const environmentId = environmentWithScope(context, input, "read");
      const subscriptionId = requiredString(input, "subscriptionId");
      const subscription = events.subscriptionById(subscriptionId);
      if (subscription === undefined || subscription.environmentId !== environmentId) {
        throw new GatewayError({
          code: "unknown_subscription",
          message: `Subscription ${subscriptionId} does not belong to environment ${environmentId}.`,
          retryable: false,
          environmentId,
        });
      }
      const limit =
        typeof input.limit === "number" ? Math.max(1, Math.min(500, Math.trunc(input.limit))) : 200;
      const items = events.pendingFor(subscriptionId, limit);
      return {
        subscriptionId,
        items,
        ackedSequence: subscription.ackedSequence,
        hasMore: items.length === limit,
      };
    }
    case "t3_git_status":
    case "t3_get_diff": {
      const environmentId = environmentWithScope(context, input, "read");
      const execute = requireOperationPort(context);
      return execute({
        environmentId,
        operation: name === "t3_git_status" ? "git.status" : "git.diff",
        payload: input,
        ...(typeof input.requestId === "string" ? { requestId: input.requestId } : {}),
      });
    }
    case "t3_reclaim_worktree": {
      const environmentId = environmentWithScope(
        context,
        input,
        input.dryRun === true ? "read" : "lifecycle",
      );
      const execute = requireOperationPort(context);
      return execute({
        environmentId,
        operation: "worktree.reclaim",
        payload: input,
        ...(typeof input.requestId === "string" ? { requestId: input.requestId } : {}),
      });
    }
    case "t3_apply_patch":
    case "t3_create_branch":
    case "t3_commit_changes":
    case "t3_create_pr":
    case "t3_update_pr":
    case "t3_reply_review_comment":
    case "t3_apply_review_fixes":
    case "t3_publish_pr": {
      const requiredScopes: ReadonlyArray<GatewayScope> =
        name === "t3_apply_patch" || name === "t3_create_branch" || name === "t3_commit_changes"
          ? ["admin"]
          : name === "t3_publish_pr"
            ? ["review", "admin"]
            : ["review"];
      const environmentId = environmentWithScopes(context, input, requiredScopes);
      const idempotencyKey = requiredIdempotencyKey(input);
      await assertProjectRepositoryAllowed(context, environmentId, input);
      if (name === "t3_publish_pr" && input.confirmDestructive !== true) {
        throw new GatewayError({
          code: "destructive_confirmation_required",
          message: "Publishing a pull request requires confirmDestructive: true.",
          retryable: false,
          environmentId,
        });
      }
      if (name === "t3_apply_patch") {
        assertPatchPathsAreProjectRelative(requiredString(input, "patch"));
      }
      if (name === "t3_create_pr") {
        const owner = requiredString(input, "owner");
        const projects = await context.port.listProjects(environmentId);
        const project = projects.items.find(
          (candidate) => candidate.id === requiredString(input, "projectId"),
        );
        const repositoryIdentity =
          typeof project?.repositoryIdentity === "object" && project.repositoryIdentity !== null
            ? (project.repositoryIdentity as Record<string, unknown>)
            : undefined;
        if (
          typeof repositoryIdentity?.owner !== "string" ||
          repositoryIdentity.owner !== owner ||
          typeof repositoryIdentity.name !== "string" ||
          repositoryIdentity.name !== requiredString(input, "repository")
        ) {
          throw new GatewayError({
            code: "invalid_input",
            message: `Pull request owner ${owner} is outside the selected project's repository identity.`,
            retryable: false,
            environmentId,
          });
        }
        assertRepositoryAllowed(context, environmentId, owner, requiredString(input, "repository"));
      }
      const operations: Record<string, string> = {
        t3_apply_patch: "git.apply_patch",
        t3_create_branch: "git.create_branch",
        t3_commit_changes: "git.commit",
        t3_create_pr: "git.create_pr",
        t3_update_pr: "pr.update",
        t3_reply_review_comment: "pr.reply",
        t3_apply_review_fixes: "pr.apply_review_fixes",
        t3_publish_pr: "pr.publish",
      };
      const execute = requireOperationPort(context);
      const authoritativeRequestId = scopedIdFor(
        "operation",
        environmentId,
        requiredString(input, "projectId"),
        idempotencyKey,
      );
      const legacyRequestId = idFor("operation", idempotencyKey);
      return withIdempotency(
        context,
        `${environmentId}::${idFor("operation", idempotencyKey)}`,
        idempotencyCommandPayload(operations[name] as string, input),
        (prepared) => {
          if (
            prepared?.requestId !== authoritativeRequestId &&
            prepared?.requestId !== legacyRequestId
          ) {
            throw new GatewayError({
              code: "idempotency_conflict",
              message: "This operation has no recoverable authoritative command identity.",
              retryable: false,
              environmentId,
              requestId: authoritativeRequestId,
            });
          }
          return execute({
            environmentId,
            operation: operations[name] as string,
            payload: input,
            requestId: prepared.requestId,
          });
        },
        () => ({ requestId: authoritativeRequestId }),
      );
    }
    case "t3_create_thread": {
      const environmentId = environmentWithScope(context, input, "create");
      const idempotencyKey = requiredIdempotencyKey(input);
      // Explicit null opts out; otherwise a chat creating chats, on any environment, parents them.
      const parentThreadId =
        input.parentThreadId === null
          ? undefined
          : typeof input.parentThreadId === "string"
            ? input.parentThreadId.trim()
            : invocation.caller?.threadId;
      const parentEnvironmentId =
        parentThreadId === undefined
          ? undefined
          : typeof input.parentThreadId === "string" &&
              typeof input.parentEnvironmentId === "string"
            ? input.parentEnvironmentId.trim()
            : // The calling chat is on the caller's environment, even when named explicitly.
              parentThreadId === invocation.caller?.threadId
              ? invocation.caller.environmentId
              : undefined;
      // Checked here: the target environment cannot verify a parent on another environment.
      if (typeof input.parentThreadId === "string" && parentThreadId !== undefined) {
        const parentEnvironment = parentEnvironmentId ?? environmentId;
        const parent = await getThreadOrNotFound(context, parentEnvironment, parentThreadId).catch(
          (error: unknown) => {
            if (error instanceof GatewayError && error.code === "thread_not_found")
              return undefined;
            throw error;
          },
        );
        if (parent === undefined || parent.archivedAt != null || parent.deletedAt != null) {
          throw new GatewayError({
            code: "invalid_input",
            message: `parentThreadId ${parentThreadId} is not a chat on environment ${parentEnvironment}; omit parentThreadId to nest under the calling chat.`,
            retryable: false,
            environmentId: parentEnvironment,
          });
        }
      }
      const profileName = typeof input.profile === "string" ? input.profile.trim() : "";
      const profileIdInput = typeof input.profileId === "string" ? input.profileId.trim() : "";
      const legacyIdentity = {
        threadId: idFor("thread", idempotencyKey),
        requestId: idFor("request", idempotencyKey),
      };
      const currentThreadId = scopedIdFor("thread", environmentId, "create", idempotencyKey);
      const currentIdentity = {
        threadId: currentThreadId,
        requestId: scopedIdFor("thread", environmentId, currentThreadId, idempotencyKey),
      };
      const buildRequest = async (identity: typeof currentIdentity) => {
        await context.port.syncAgentLibrary?.(environmentId);
        const profiles = await authoritativeProfiles(context, environmentId);
        const profile =
          profileIdInput !== ""
            ? profiles.find((candidate) => candidate.profileId === profileIdInput)
            : profileName === ""
              ? undefined
              : profiles.find((candidate) => candidate.name === profileName);
        if ((profileName !== "" || profileIdInput !== "") && profile === undefined) {
          throw new GatewayError({
            code: "invalid_input",
            message: `Unknown gateway profile ${profileIdInput || profileName}.`,
            retryable: false,
          });
        }
        if (
          profile !== undefined &&
          (typeof profile.profileId !== "string" ||
            profile.profileId.trim() === "" ||
            !Number.isInteger(profile.revision))
        ) {
          throw new GatewayError({
            code: "invalid_input",
            message: `Gateway profile ${profile.name} is not a server-owned revisioned profile.`,
            retryable: false,
            environmentId,
          });
        }
        const authoritativeProfileRef =
          profile === undefined
            ? undefined
            : { profileId: profile.profileId as string, revision: profile.revision as number };
        if (
          profile !== undefined &&
          Array.isArray(profile.environmentIds) &&
          profile.environmentIds.length > 0 &&
          !profile.environmentIds.includes(environmentId)
        ) {
          throw new GatewayError({
            code: "scope_required",
            message: `Profile ${profile.name} is not allowed in environment ${environmentId}.`,
            retryable: false,
            environmentId,
            details: { profileId: profile.profileId, permission: "environment-allowlist" },
          });
        }
        if (profile?.runtimeMode === "read-only") {
          throw new GatewayError({
            code: "scope_required",
            message: `Profile ${profile.name} is read-only and cannot create a thread.`,
            retryable: false,
            environmentId,
            details: { profileId: profile.profileId, permission: "read-only" },
          });
        }
        const hasThreadModel = input.modelSelection !== undefined;
        const profileModelSelection = hasThreadModel
          ? undefined
          : profile === undefined
            ? undefined
            : context.port.resolveProfileModelSelection === undefined
              ? profile.modelSelection
              : await context.port.resolveProfileModelSelection(environmentId, profile);
        const rawModelSelection = input.modelSelection ?? profileModelSelection;
        // Profile labels need an unambiguous match in the target environment's live catalog.
        // Without a profile or override, leave model defaults to the server.
        if (rawModelSelection === undefined && profile !== undefined) {
          throw new GatewayError({
            code: "invalid_input",
            message: `Profile ${profile?.name ?? "requested"} provider/model is no longer uniquely available (provider: ${profile?.providerLabel ?? "unselected"}, model: ${profile?.modelLabel ?? "unselected"}); re-select the profile in Settings.`,
            retryable: false,
            environmentId,
            details: { profileId: profile?.profileId },
          });
        }
        const modelSelection =
          rawModelSelection === undefined ? undefined : record(rawModelSelection);
        // An agent's permission mode is owned by the user who defined it; callers
        // can neither lower nor escalate it for that agent's chats.
        const hasThreadRuntimeMode = profile === undefined && input.runtimeMode !== undefined;
        const hasThreadInteractionMode = input.interactionMode !== undefined;
        const requestedRuntimeMode = profile?.runtimeMode ?? input.runtimeMode;
        const requestedInteractionMode = input.interactionMode ?? profile?.interactionMode;
        const resolvedRuntimeMode:
          | "approval-required"
          | "auto"
          | "auto-accept-edits"
          | "full-access" =
          requestedRuntimeMode === "auto-accept-edits" ||
          requestedRuntimeMode === "auto" ||
          requestedRuntimeMode === "full-access"
            ? requestedRuntimeMode
            : "approval-required";
        const resolvedInteractionMode: "plan" | "default" =
          requestedInteractionMode === "plan" ? "plan" : "default";
        const reasoningEffort =
          typeof input.reasoningEffort === "string"
            ? input.reasoningEffort
            : profile?.reasoningEffort;
        const inheritedOptions = Array.isArray(modelSelection?.options)
          ? modelSelection.options.flatMap((candidate) => {
              const option = record(candidate);
              return option !== undefined &&
                typeof option.id === "string" &&
                (typeof option.value === "string" || typeof option.value === "boolean")
                ? [{ id: option.id, value: option.value }]
                : [];
            })
          : [];
        const modelOptions =
          reasoningEffort === undefined
            ? inheritedOptions
            : [
                ...inheritedOptions.filter((option) => option.id !== "reasoningEffort"),
                { id: "reasoningEffort", value: reasoningEffort },
              ];
        return {
          environmentId,
          projectId: requiredString(input, "projectId"),
          threadId: identity.threadId,
          title: requiredString(input, "title"),
          ...(modelSelection === undefined
            ? {}
            : {
                modelSelection: {
                  instanceId: requiredString(modelSelection, "instanceId"),
                  model: requiredString(modelSelection, "model"),
                  ...(modelOptions.length === 0 ? {} : { options: modelOptions }),
                },
              }),
          ...(resolvedRuntimeMode === undefined ? {} : { runtimeMode: resolvedRuntimeMode }),
          ...(resolvedInteractionMode === undefined
            ? {}
            : { interactionMode: resolvedInteractionMode }),
          ...(input.workspaceMode === undefined
            ? {}
            : { workspaceMode: input.workspaceMode as "checkout" | "worktree" }),
          ...(input.baseBranch === undefined
            ? {}
            : { baseBranch: requiredString(input, "baseBranch") }),
          ...(parentThreadId === undefined ? {} : { parentThreadId }),
          ...(parentEnvironmentId === undefined || parentEnvironmentId === environmentId
            ? {}
            : { parentEnvironmentId }),
          ...(authoritativeProfileRef === undefined
            ? {}
            : {
                profileSelection: {
                  ...authoritativeProfileRef,
                  overrideFields: [
                    ...(hasThreadModel ? (["modelSelection"] as const) : []),
                    ...(hasThreadRuntimeMode ? (["runtimeMode"] as const) : []),
                    ...(hasThreadInteractionMode ? (["interactionMode"] as const) : []),
                    ...(input.reasoningEffort !== undefined ? (["reasoningEffort"] as const) : []),
                  ],
                },
              }),
          requestId: identity.requestId,
        };
      };
      const recoverPreV2Create = async () => {
        const commandIds = [legacyIdentity.requestId, legacyIdentity.threadId];
        if (context.port.getCommandReceipts === undefined) {
          throw new GatewayError({
            code: "idempotency_conflict",
            message:
              "This interrupted legacy create cannot be recovered until the connected runtime supports authoritative receipt lookup.",
            retryable: false,
            environmentId,
          });
        }
        const receipts = await context.port.getCommandReceipts(environmentId, commandIds);
        const accepted = receipts.filter(
          (receipt) =>
            receipt.status === "accepted" &&
            receipt.aggregateKind === "thread" &&
            receipt.aggregateId === legacyIdentity.threadId &&
            commandIds.includes(receipt.commandId),
        );
        if (accepted.length !== 1) {
          throw new GatewayError({
            code: "idempotency_conflict",
            message:
              accepted.length === 0
                ? "No authoritative receipt exists for this interrupted legacy create."
                : "Multiple authoritative receipts exist for this interrupted legacy create.",
            retryable: false,
            environmentId,
            details: { candidateRequestIds: commandIds },
          });
        }
        const requestId = accepted[0]?.commandId as string;
        return {
          requestId,
          commandId: requestId,
          status: "accepted" as const,
          threadId: legacyIdentity.threadId,
        };
      };
      return withIdempotency(
        context,
        `${environmentId}::${idFor("thread", idempotencyKey)}`,
        input,
        async (prepared) =>
          prepared === undefined ? recoverPreV2Create() : context.port.createThread(prepared),
        () => buildRequest(currentIdentity),
      );
    }
    case "t3_create_and_start_thread": {
      const environmentId = environmentWithScopes(context, input, ["create", "send"]);
      const idempotencyKey = requiredIdempotencyKey(input);
      const messageText = requiredString(input, "text");
      const createInput = Object.fromEntries(
        Object.entries(input).filter(([key]) => key !== "text"),
      );
      const creation = await callGatewayTool(context, "t3_create_thread", createInput, invocation);
      const threadId =
        typeof creation?.threadId === "string" ? (creation.threadId as string) : undefined;
      if (threadId === undefined) {
        throw new GatewayError({
          code: "upstream_failure",
          message: "Chat creation was accepted without an authoritative chat id.",
          retryable: true,
        });
      }
      const readShell = async () => {
        try {
          return await findGatewayThread(context, environmentId, threadId);
        } catch {
          return undefined;
        }
      };
      let message: Record<string, unknown> | null = null;
      let error: Record<string, unknown> | undefined;
      try {
        const sent = await callGatewayTool(context, "t3_send_message", {
          environmentId,
          threadId,
          text: messageText,
          idempotencyKey,
          ...(typeof input.correlationId === "string"
            ? { correlationId: input.correlationId }
            : {}),
        });
        message = {
          requestId: typeof sent?.requestId === "string" ? sent.requestId : null,
          messageId: typeof sent?.messageId === "string" ? sent.messageId : null,
          status: typeof sent?.status === "string" ? sent.status : "accepted",
        };
      } catch (caught) {
        // Creation already succeeded and is durably receipted under this
        // idempotency key. Return the reachable chat plus the delivery failure
        // so the caller can inspect or retry instead of creating a duplicate.
        error =
          caught instanceof GatewayError
            ? caught.toJSON()
            : {
                code: "upstream_failure",
                message: caught instanceof Error ? caught.message : String(caught),
                retryable: true,
              };
      }
      const finalThread = await readShell();
      const executionState =
        finalThread === undefined ? null : (readThreadExecutionState(finalThread) ?? null);
      return {
        environmentId,
        threadId,
        status: error === undefined ? "started" : "partial",
        partial: error !== undefined,
        retryable: error === undefined ? false : error.retryable === true,
        executionState,
        creation: {
          requestId: typeof creation?.requestId === "string" ? creation.requestId : null,
          status: typeof creation?.status === "string" ? creation.status : "accepted",
        },
        message,
        ...(error === undefined ? {} : { error }),
        ...(finalThread === undefined
          ? {}
          : {
              thread: {
                id: threadId,
                title: typeof finalThread.title === "string" ? finalThread.title : null,
                projectId: typeof finalThread.projectId === "string" ? finalThread.projectId : null,
                status: executionState,
                settledAt: finalThread.settledAt ?? null,
                updatedAt: finalThread.updatedAt ?? null,
              },
            }),
        snapshotAt: "runtime",
      };
    }
    case "t3_wait_for_thread_status": {
      const events = requireEventStore(context);
      const environmentId = environmentWithScope(context, input, "read");
      const threadId = requiredString(input, "threadId");
      const untilStatuses = parseUntilStatuses(input.untilStatuses);
      const timeoutMs = boundedTimeoutMs(input.timeoutMs, 30_000);
      const requestedCursor =
        typeof input.afterSequence === "number"
          ? Math.max(0, Math.trunc(input.afterSequence))
          : events.latestSequence(environmentId);
      const cursorEvent =
        typeof input.afterSequence === "number"
          ? events.eventAtOrBefore(
              environmentId,
              threadId,
              requestedCursor,
              (event) => gatewayEventExecutionState(event) !== undefined,
            )
          : undefined;
      const baseline = await findGatewayThread(context, environmentId, threadId);
      const currentStatus =
        baseline === undefined ? null : (readThreadExecutionState(baseline) ?? null);
      // A resumed call compares against the status at its cursor. Reading the
      // current shell as the baseline would swallow changes between calls.
      const previousStatus =
        typeof input.afterSequence === "number"
          ? cursorEvent === undefined
            ? null
            : (gatewayEventExecutionState(cursorEvent) ?? null)
          : currentStatus;
      const matches = (candidate: GatewayThreadExecutionState | null | undefined): boolean => {
        if (candidate === undefined || candidate === null) return false;
        return untilStatuses === undefined
          ? candidate !== previousStatus
          : untilStatuses.includes(candidate);
      };
      // @effect-diagnostics-next-line globalDate:off - This tool handler is plain Node, not an Effect service; elapsed time is only reported to the caller.
      const startedAt = Date.now();
      let cursor = requestedCursor;
      let lastEvent: GatewayEvent | undefined;
      let status: GatewayThreadExecutionState | null = currentStatus;
      let matched = untilStatuses !== undefined && matches(currentStatus);
      let timedOut = false;
      if (!matched) {
        const deadline = startedAt + timeoutMs;
        for (;;) {
          // @effect-diagnostics-next-line globalDate:off - Plain Node tool handler; only bounds this wait.
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            timedOut = true;
            break;
          }
          const event = await events.waitForEvent({
            environmentId,
            threadId,
            afterSequence: cursor,
            timeoutMs: remaining,
            predicate: (candidate) => gatewayEventExecutionState(candidate) !== undefined,
          });
          if (event === undefined) {
            timedOut = true;
            break;
          }
          cursor = Math.max(cursor, event.sequence);
          lastEvent = event;
          const candidate = gatewayEventExecutionState(event);
          if (!matches(candidate)) continue;
          // Confirm against the authoritative shell so a replayed historical
          // event cannot satisfy a wait after the status already moved on.
          const verified = await findGatewayThread(context, environmentId, threadId).catch(
            () => undefined,
          );
          const verifiedStatus =
            verified === undefined ? candidate : (readThreadExecutionState(verified) ?? candidate);
          if (matches(verifiedStatus)) {
            status = verifiedStatus ?? status;
            matched = true;
            break;
          }
        }
      }
      const finalThread =
        (await findGatewayThread(context, environmentId, threadId).catch(() => undefined)) ??
        baseline;
      if (finalThread !== undefined) {
        status = readThreadExecutionState(finalThread) ?? status;
      }
      return {
        environmentId,
        threadId,
        status,
        previousStatus,
        changed: status !== previousStatus,
        matched,
        timedOut,
        // @effect-diagnostics-next-line globalDate:off - Reports elapsed wait time to the caller.
        waitedMs: Date.now() - startedAt,
        cursor: Math.max(cursor, events.latestSequence(environmentId), lastEvent?.sequence ?? 0),
        ...(lastEvent === undefined
          ? {}
          : {
              lastEvent: {
                eventId: lastEvent.eventId,
                type: lastEvent.type,
                sequence: lastEvent.sequence,
                occurredAt: lastEvent.occurredAt,
                ...(gatewayEventExecutionState(lastEvent) === undefined
                  ? {}
                  : { status: gatewayEventExecutionState(lastEvent) }),
              },
            }),
        thread:
          finalThread === undefined
            ? null
            : {
                id: typeof finalThread.id === "string" ? finalThread.id : threadId,
                title: typeof finalThread.title === "string" ? finalThread.title : null,
                projectId: typeof finalThread.projectId === "string" ? finalThread.projectId : null,
                status,
                settledAt: finalThread.settledAt ?? null,
                hasPendingApprovals: finalThread.hasPendingApprovals === true,
                hasPendingUserInput: finalThread.hasPendingUserInput === true,
                latestTurnState:
                  typeof finalThread.latestTurn === "object" && finalThread.latestTurn !== null
                    ? ((finalThread.latestTurn as Record<string, unknown>).state ?? null)
                    : null,
                sessionStatus:
                  typeof finalThread.session === "object" && finalThread.session !== null
                    ? ((finalThread.session as Record<string, unknown>).status ?? null)
                    : null,
                updatedAt: finalThread.updatedAt ?? null,
              },
        snapshotAt: "runtime",
      };
    }
    case "t3_send_message": {
      const environmentId = environmentWithScope(context, input, "send");
      const idempotencyKey = requiredIdempotencyKey(input);
      const threadId = requiredString(input, "threadId");
      const idempotencyStoreKey = `${environmentId}::${threadId}::${idFor("request", idempotencyKey)}`;
      const historicalRequestIds = [
        idFor("request", idempotencyKey),
        scopedIdFor("request", environmentId, threadId, idempotencyKey),
      ];
      const authoritativeRequestId = scopedIdFor(
        "message-send",
        environmentId,
        threadId,
        idempotencyKey,
      );
      const authoritativeMessageId = scopedIdFor(
        "message",
        environmentId,
        threadId,
        idempotencyKey,
      );
      await assertRecoverableHistoricalSend(
        context,
        idempotencyStoreKey,
        environmentId,
        threadId,
        authoritativeRequestId,
        historicalRequestIds,
      );
      return withIdempotency(
        context,
        idempotencyStoreKey,
        idempotencyCommandPayload("message.send", input),
        (prepared) =>
          context.port.sendMessage({
            environmentId,
            threadId,
            text: requiredString(input, "text"),
            messageId: prepared?.messageId ?? idFor("message", idempotencyKey),
            requestId: prepared?.requestId ?? idFor("request", idempotencyKey),
          }),
        () => ({ requestId: authoritativeRequestId, messageId: authoritativeMessageId }),
      );
    }
    case "t3_control_thread": {
      // `control` was shipped before the explicit v3 `lifecycle` scope. Keep
      // it as a narrow compatibility grant for thread control instead of
      // silently expanding it to any other v3 authority.
      const environmentId = environmentWithAnyScope(context, input, ["control", "lifecycle"]);
      const idempotencyKey = requiredIdempotencyKey(input);
      const rawAction = requiredString(input, "action");
      if (
        !(["cancel", "stop", "pause", "resume", "retry", "restart"] as const).some(
          (value) => value === rawAction,
        )
      ) {
        throw new GatewayError({
          code: "invalid_input",
          message: `Unsupported thread control action ${rawAction}.`,
          retryable: false,
        });
      }
      const action = rawAction as GatewayThreadControlAction;
      const threadId = requiredString(input, "threadId");
      const authoritativeRequestId = scopedIdFor(
        "thread-control",
        environmentId,
        threadId,
        idempotencyKey,
      );
      const authoritativeMessageId = scopedIdFor(
        "message",
        environmentId,
        threadId,
        idempotencyKey,
      );
      return withIdempotency(
        context,
        `${environmentId}::${threadId}::${idFor("request", idempotencyKey)}`,
        idempotencyCommandPayload("thread.control", input),
        (prepared) =>
          context.port.controlThread({
            environmentId,
            threadId,
            action,
            requestId: prepared?.requestId ?? idFor("request", idempotencyKey),
            messageId: prepared?.messageId ?? idFor("message", idempotencyKey),
          }),
        () => ({ requestId: authoritativeRequestId, messageId: authoritativeMessageId }),
      );
    }
    case "t3_get_pending_questions": {
      const environmentId = environmentWithScope(context, input, "read");
      const thread = await getThreadOrNotFound(
        context,
        environmentId,
        requiredString(input, "threadId"),
      );
      return {
        environmentId,
        threadId: thread.id,
        title: thread.title,
        status: thread.status,
        pendingQuestions: pendingQuestionsOf(thread),
      };
    }
    case "t3_answer_question": {
      const environmentId = environmentWithScope(context, input, "send");
      const idempotencyKey = requiredIdempotencyKey(input);
      const threadId = requiredString(input, "threadId");
      const respond = context.port.respondToUserInput;
      if (respond === undefined) {
        throw new Error("Answering questions is unavailable in this runtime. Update T3.");
      }
      const answers = z
        .array(
          z.object({
            questionId: z.string().optional(),
            options: z.array(z.string()).optional(),
            text: z.string().optional(),
          }),
        )
        .min(1)
        .parse(input.answers);
      return withIdempotency(
        context,
        `${environmentId}::${threadId}::${idFor("request", idempotencyKey)}`,
        idempotencyCommandPayload("user-input.respond", input),
        async (prepared) => {
          const receipt = await respond({
            environmentId,
            threadId,
            userInputRequestId: prepared!.questionRequestId,
            answers: prepared!.answers,
            requestId: prepared!.requestId,
          });
          return {
            ...receipt,
            questionRequestId: prepared!.questionRequestId,
            answers: prepared!.answers,
          };
        },
        async () => {
          // Answers are checked against the live question, so a stale or
          // mistyped choice fails here instead of reaching the provider.
          const pending = pendingQuestionsOf(
            await getThreadOrNotFound(context, environmentId, threadId),
          );
          const wanted =
            typeof input.questionRequestId === "string" ? input.questionRequestId : undefined;
          const request =
            wanted === undefined
              ? pending.length === 1
                ? pending[0]
                : undefined
              : pending.find((candidate) => candidate.questionRequestId === wanted);
          if (request === undefined) {
            throw new GatewayError({
              code: pending.length === 0 || wanted !== undefined ? "stale_plan" : "invalid_input",
              message:
                pending.length === 0
                  ? "This chat is not waiting on a question."
                  : wanted === undefined
                    ? `This chat has ${pending.length} pending questions; pass questionRequestId.`
                    : `Question request ${wanted} is no longer pending. Read the pending questions again.`,
              retryable: false,
              environmentId,
              details: { threadId, pendingQuestions: pending },
            });
          }
          return {
            questionRequestId: request.questionRequestId,
            answers: resolveQuestionAnswers(request, answers),
            requestId: scopedIdFor("user-input-response", environmentId, threadId, idempotencyKey),
          };
        },
      );
    }
    case "t3_respond_to_approval": {
      const environmentId = environmentWithScope(context, input, "approval");
      const idempotencyKey = requiredIdempotencyKey(input);
      const rawDecision = requiredString(input, "decision");
      if (
        !(["accept", "acceptForSession", "decline", "cancel"] as const).some(
          (value) => value === rawDecision,
        )
      ) {
        throw new GatewayError({
          code: "invalid_input",
          message: `Unsupported approval decision ${rawDecision}.`,
          retryable: false,
        });
      }
      const decision = rawDecision as GatewayApprovalDecision;
      const threadId = requiredString(input, "threadId");
      const authoritativeRequestId = scopedIdFor(
        "approval-response",
        environmentId,
        threadId,
        idempotencyKey,
      );
      return withIdempotency(
        context,
        `${environmentId}::${threadId}::${idFor("request", idempotencyKey)}`,
        idempotencyCommandPayload(`approval.respond.${decision}`, input),
        (prepared) =>
          context.port.respondToApproval({
            environmentId,
            threadId,
            approvalRequestId: requiredString(input, "approvalRequestId"),
            decision,
            requestId: prepared?.requestId ?? idFor("request", idempotencyKey),
          }),
        async () => {
          if (decision !== "accept" && decision !== "acceptForSession") {
            return { requestId: authoritativeRequestId };
          }
          const approvalRequestId = requiredString(input, "approvalRequestId");
          const thread = await getThreadOrNotFound(context, environmentId, threadId);
          const plan = approvalPlan(thread);
          const action = plan.actions.find(
            (candidate) => candidate.approvalActionId === approvalRequestId,
          );
          // Missing actions cannot authorize new dispatches, even if truncated from recent activity.
          // Only a durable dispatched marker permits uncertain-command recovery to bypass this check.
          if (action === undefined) {
            throw new GatewayError({
              code: "stale_plan",
              message: `Approval request ${approvalRequestId} is not pending in the current approval plan. Re-fetch the plan and retry.`,
              retryable: false,
              environmentId,
              details: { approvalPlanId: plan.approvalPlanId, currentRevision: plan.revision },
            });
          }
          if (
            action.requiresDestructiveConfirmation === true &&
            input.confirmDestructive !== true
          ) {
            throw new GatewayError({
              code: "destructive_confirmation_required",
              message: `Action ${String(action.approvalActionId)} requires confirmDestructive: true.`,
              retryable: false,
              environmentId,
            });
          }
          return { requestId: authoritativeRequestId };
        },
      );
    }
    case "t3_subscribe_events": {
      const events = requireEventStore(context);
      const environmentId = environmentWithScope(context, input, "read");
      const types = Array.isArray(input.types)
        ? input.types.filter((candidate): candidate is string => typeof candidate === "string")
        : undefined;
      const subscription = events.subscribe({
        environmentId,
        ...(types === undefined ? {} : { types }),
        ...(typeof input.afterSequence === "number"
          ? { afterSequence: Math.max(0, Math.trunc(input.afterSequence)) }
          : {}),
      });
      return {
        subscriptionId: subscription.subscriptionId,
        environmentId: subscription.environmentId,
        ...(subscription.types === undefined ? {} : { types: subscription.types }),
        ackedSequence: subscription.ackedSequence,
      };
    }
    case "t3_get_events": {
      const events = requireEventStore(context);
      const environmentId = environmentWithScope(context, input, "read");
      const afterSequence =
        typeof input.afterSequence === "number" ? Math.max(0, Math.trunc(input.afterSequence)) : 0;
      const limit =
        typeof input.limit === "number" ? Math.max(1, Math.min(500, Math.trunc(input.limit))) : 200;
      const types = Array.isArray(input.types)
        ? input.types.filter((candidate): candidate is string => typeof candidate === "string")
        : undefined;
      const history = events.history(environmentId, afterSequence, limit, types);
      return {
        items: history,
        latestSequence: events.latestSequence(environmentId),
        hasMore: history.length === limit,
      };
    }
    case "t3_ack_events": {
      const events = requireEventStore(context);
      const environmentId = environmentWithScope(context, input, "read");
      const subscriptionId = requiredString(input, "subscriptionId");
      const subscription = events.subscriptionById(subscriptionId);
      if (subscription === undefined || subscription.environmentId !== environmentId) {
        throw new GatewayError({
          code: "unknown_subscription",
          message: `Subscription ${subscriptionId} does not belong to environment ${environmentId}.`,
          retryable: false,
          environmentId,
        });
      }
      const acked = events.ack(subscriptionId, Math.trunc(Number(input.throughSequence)));
      return { subscriptionId: acked.subscriptionId, ackedSequence: acked.ackedSequence };
    }
    case "t3_register_webhook": {
      const events = requireEventStore(context);
      const environmentId = environmentWithScopes(context, input, ["read", "delivery"]);
      const { webhook, secret } = events.registerWebhook({
        environmentId,
        url: requiredString(input, "url"),
        ...(Array.isArray(input.types)
          ? { types: input.types.filter((t): t is string => typeof t === "string") }
          : {}),
      });
      return { ...webhook, secret, secretReference: `webhook-secret/${webhook.webhookId}` };
    }
    case "t3_update_webhook": {
      const events = requireEventStore(context);
      const environmentId = environmentWithScopes(context, input, ["read", "delivery"]);
      const types = Array.isArray(input.types)
        ? input.types.filter((t): t is string => typeof t === "string")
        : undefined;
      const patch = types === undefined ? {} : { types };
      return events.updateWebhook(environmentId, requiredString(input, "webhookId"), patch);
    }
    case "t3_rotate_webhook_secret": {
      const events = requireEventStore(context);
      const environmentId = environmentWithScopes(context, input, ["read", "delivery"]);
      const { webhook, secret } = events.rotateWebhookSecret(
        environmentId,
        requiredString(input, "webhookId"),
      );
      return { ...webhook, secret, secretReference: `webhook-secret/${webhook.webhookId}` };
    }
    case "t3_delete_webhook": {
      const events = requireEventStore(context);
      const environmentId = environmentWithScopes(context, input, ["read", "delivery"]);
      events.deleteWebhook(environmentId, requiredString(input, "webhookId"));
      return { deleted: true };
    }
    case "t3_list_webhooks": {
      const events = requireEventStore(context);
      const environmentId = environmentWithScopes(context, input, ["read", "delivery"]);
      return { items: events.listWebhooks(environmentId) };
    }
    default:
      throw new GatewayError({
        code: "unknown_tool",
        message: `Unknown tool ${name}.`,
        retryable: false,
      });
  }
}
