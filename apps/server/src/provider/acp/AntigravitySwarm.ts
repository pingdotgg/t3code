// @effect-diagnostics nodeBuiltinImport:off -- reads the native swarm board files without following links.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import type {
  OrchestrationV2SubagentWorkflow,
  OrchestrationV2WorkflowAgent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { antigravityManagedPath, antigravityProfileRoot } from "./AntigravityProfilePaths.ts";

const NATIVE_ID = /^[A-Za-z0-9-]{1,64}$/;
const MAX_ROSTER_BYTES = 256 * 1024;
const BOARD_TAIL_BYTES = 512 * 1024;
const TRANSCRIPT_TAIL_BYTES = [64 * 1024, 1024 * 1024];
const MAX_MEMBERS = 64;
const TEXT_CAP = 4_000;
// The swarm's own helpers, not task workers; the board view leaves them out the same way.
const SUPPORT_ROLE = /^(narrator|monitor)(-\d+)?$/;
// Workers open a final result with `[done]`, after the @mention that wakes its reader.
const DONE_MARK = /^(?:@[A-Za-z0-9._-]+\s+)*\[done\]/i;

/** With the Swarm toggle on, a message the user did not start with a command runs as `/swarm`. */
export function antigravitySwarmPrompt(text: string, swarm: boolean | undefined): string {
  const trimmed = text.trimStart();
  return swarm === true && trimmed !== "" && !trimmed.startsWith("/") ? `/swarm ${text}` : text;
}

/** Native task id T3 gives a swarm, so its record survives every turn of the coordinator thread. */
export const antigravitySwarmTaskId = (sessionId: string) => `swarm:${sessionId}`;

const SwarmToolInput = Schema.Struct({ action: Schema.String });
const decodeSwarmToolInput = Schema.decodeUnknownOption(SwarmToolInput);

/** The coordinator's `swarm` tool. ACP reports it as `Run swarm` with the action as input. */
export function isAntigravitySwarmToolCall(toolCall: {
  readonly kind?: string;
  readonly title?: string;
  readonly data: Record<string, unknown>;
}): boolean {
  if (toolCall.kind !== undefined && toolCall.kind !== "other") return false;
  if (toolCall.title !== "Run swarm" && toolCall.title !== "Run swarm?") return false;
  return Option.isSome(decodeSwarmToolInput(toolCall.data.rawInput));
}

const Member = Schema.Struct({
  conversation_id: Schema.optional(Schema.String),
  role: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  applied_model: Schema.optional(Schema.String),
  desired_model: Schema.optional(Schema.String),
  desired_state: Schema.optional(Schema.String),
  phase: Schema.optional(Schema.String),
  killed: Schema.optional(Schema.Boolean),
});
const decodeRoster = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      title: Schema.optional(Schema.String),
      members: Schema.Record(Schema.String, Member),
    }),
  ),
);
const Post = Schema.Struct({
  seq: Schema.Int,
  agent: Schema.String,
  text: Schema.String,
  time: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String),
});
type Post = typeof Post.Type;
const decodePost = Schema.decodeUnknownOption(Schema.fromJsonString(Post));
const Step = Schema.Struct({
  step_index: Schema.optional(Schema.Number),
  type: Schema.String,
  status: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  created_at: Schema.optional(Schema.String),
  input_tokens: Schema.optional(Schema.Unknown),
  output_tokens: Schema.optional(Schema.Unknown),
  tool_calls: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String }))),
});
type Step = typeof Step.Type;
const decodeStep = Schema.decodeUnknownOption(Schema.fromJsonString(Step));

async function readTail(
  path: string,
  maxBytes: number,
): Promise<{ readonly text: string; readonly whole: boolean } | undefined> {
  const handle = await NodeFSP.open(
    path,
    NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return undefined;
    const start = Math.max(0, stat.size - maxBytes);
    // One byte before the window tells a record boundary from a cut record.
    const readStart = Math.max(0, start - 1);
    const buffer = Buffer.alloc(stat.size - readStart);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, readStart);
    const bytes = buffer.subarray(0, bytesRead);
    if (start === 0) return { text: bytes.toString("utf8"), whole: true };
    const newline = bytes.indexOf(0x0a);
    return { text: newline === -1 ? "" : bytes.toString("utf8", newline + 1), whole: false };
  } finally {
    await handle.close();
  }
}

const brainFile = (conversationId: string, ...rest: ReadonlyArray<string>) => [
  "antigravity-acp",
  "brain",
  conversationId,
  ".system_generated",
  ...rest,
];

function lines<A>(text: string, decode: (line: string) => Option.Option<A>): ReadonlyArray<A> {
  return text.split("\n").flatMap((line) => Option.toArray(decode(line)));
}

// Board and transcript times are the runtime's local wall clock without a zone.
function epochMillis(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const millis = Date.parse(value.includes("T") ? value : value.replace(" ", "T"));
  return Number.isFinite(millis) ? millis : undefined;
}

const tokenCount = (value: unknown) =>
  value === undefined
    ? 0
    : typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : undefined;

const capText = (value: string) =>
  value.length <= TEXT_CAP ? value : `${value.slice(0, TEXT_CAP)}…`;

/** Whether the member's newest turn has ended: a final reply, or a batch that parked in `swarm_wait`. */
function turnEnded(steps: ReadonlyArray<Step>): boolean {
  let results = 0;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step === undefined) return false;
    if (step.type === "GENERIC") {
      results += 1;
      continue;
    }
    if (step.type !== "PLANNER_RESPONSE") return false;
    const calls = step.tool_calls ?? [];
    if (calls.length === 0) return results === 0;
    const wait = calls.findIndex((call) => call.name === "swarm_wait");
    if (wait < 0 || results < calls.length) return false;
    return steps[index + 1 + wait]?.status === "DONE";
  }
  return false;
}

interface MemberActivity {
  readonly ended: boolean;
  readonly failed: string | undefined;
  readonly startedAt: number | undefined;
  readonly lastAt: number | undefined;
  /** The newest step's index: it moves whenever the worker does anything. */
  readonly lastStep: number | undefined;
  /** Only when the whole transcript was read; a tail would undercount. */
  readonly usage: { readonly totalTokens: number; readonly toolCalls: number } | undefined;
}

async function readActivity(
  profileRoot: string,
  conversationId: string,
): Promise<MemberActivity | undefined> {
  const file = await antigravityManagedPath(
    profileRoot,
    brainFile(conversationId, "logs", "transcript.jsonl"),
    "file",
  );
  if (file === undefined) return undefined;
  let tail: Awaited<ReturnType<typeof readTail>>;
  let steps: ReadonlyArray<Step> = [];
  // A large tool result can push the planner step that called it out of a short tail.
  for (const bytes of TRANSCRIPT_TAIL_BYTES) {
    tail = await readTail(file.path, bytes).catch(() => undefined);
    if (tail === undefined) return undefined;
    steps = lines(tail.text, decodeStep);
    if (tail.whole || steps.some((step) => step.type !== "GENERIC")) break;
  }
  if (tail === undefined) return undefined;
  const last = steps.at(-1);
  // An invalid count makes the total unknown, not smaller.
  let tokens: number | undefined = 0;
  let toolCalls = 0;
  for (const step of steps) {
    const input = tokenCount(step.input_tokens);
    const output = tokenCount(step.output_tokens);
    tokens =
      tokens === undefined || input === undefined || output === undefined
        ? undefined
        : tokens + input + output;
    toolCalls += step.tool_calls?.length ?? 0;
  }
  return {
    ended: turnEnded(steps),
    failed:
      last?.type === "ERROR_MESSAGE"
        ? (last.error ?? "The agent stopped on a model error.")
        : undefined,
    startedAt: epochMillis(steps[0]?.created_at),
    lastAt: epochMillis(last?.created_at),
    lastStep: last?.step_index,
    usage: tail.whole && tokens !== undefined ? { totalTokens: tokens, toolCalls } : undefined,
  };
}

const memberModel = (member: typeof Member.Type) =>
  [member.model, member.applied_model, member.desired_model].find(
    (model) => model !== undefined && model.trim() !== "",
  );

const killed = (member: typeof Member.Type) =>
  member.killed === true || member.desired_state === "KILLED" || member.phase === "KILLED";

class AntigravitySwarmReadError extends Schema.TaggedError<AntigravitySwarmReadError>()(
  "AntigravitySwarmReadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read the Antigravity swarm board.";
  }
}

export interface AntigravitySwarmSnapshot {
  readonly workflow: OrchestrationV2SubagentWorkflow;
  /** The coordinator's brief to each worker, in the order they joined. */
  readonly prompt: string;
  /** True while any worker still works; parked and killed workers do not count. */
  readonly active: boolean;
  /** Changes whenever any worker records a step, shown or not: proof the swarm progresses. */
  readonly progress: string;
}

/**
 * Reads the coordinator session's swarm board: the roster, the board feed and each worker's
 * transcript tail. Workers become workflow agents; the coordinator and helpers are left out.
 * Returns undefined when this session coordinates no swarm or its records cannot be read.
 */
export const readAntigravitySwarm = Effect.fn("readAntigravitySwarm")(function* (input: {
  readonly profileDirectory: string;
  readonly sessionId: string;
}) {
  if (!NATIVE_ID.test(input.sessionId)) return undefined;
  const read = async (): Promise<AntigravitySwarmSnapshot | undefined> => {
    const profileRoot = await antigravityProfileRoot(input.profileDirectory);
    if (profileRoot === undefined) return undefined;
    const rosterFile = await antigravityManagedPath(
      profileRoot,
      brainFile(input.sessionId, "swarm", "members.json"),
      "file",
    );
    if (rosterFile === undefined) return undefined;
    // The cap holds at read time; a roster that outgrew it is not parsed cut.
    const rosterText = await readTail(rosterFile.path, MAX_ROSTER_BYTES);
    if (rosterText?.whole !== true) return undefined;
    const roster = Option.getOrUndefined(decodeRoster(rosterText.text));
    if (roster === undefined) return undefined;
    const coordinator = Object.entries(roster.members).find(
      ([, member]) => member.role === "coordinator",
    );
    // Only the swarm this session coordinates; a worker's own board view belongs to its coordinator.
    if (coordinator === undefined || coordinator[1].conversation_id !== input.sessionId) {
      return undefined;
    }
    const boardFile = await antigravityManagedPath(
      profileRoot,
      brainFile(input.sessionId, "swarm", "board.jsonl"),
      "file",
    );
    const board: ReadonlyArray<Post> =
      boardFile === undefined
        ? []
        : lines((await readTail(boardFile.path, BOARD_TAIL_BYTES))?.text ?? "", decodePost);
    const coordinatorName = coordinator[0];
    const briefs = new Map<string, Post>();
    const results = new Map<string, Post>();
    for (const post of board) {
      if (post.agent === coordinatorName && post.kind === "brief") {
        const named = /^@([A-Za-z0-9._-]+)/.exec(post.text)?.[1];
        if (named !== undefined && !briefs.has(named)) briefs.set(named, post);
      } else if (post.agent !== coordinatorName && DONE_MARK.test(post.text)) {
        results.set(post.agent, post);
      }
    }
    const workers = Object.entries(roster.members)
      .filter(
        ([name, member]) =>
          member.role !== "coordinator" &&
          !SUPPORT_ROLE.test(member.role ?? "") &&
          !(member.role === undefined && SUPPORT_ROLE.test(name)),
      )
      .sort(
        ([left], [right]) =>
          (briefs.get(left)?.seq ?? Number.MAX_SAFE_INTEGER) -
            (briefs.get(right)?.seq ?? Number.MAX_SAFE_INTEGER) || left.localeCompare(right),
      );
    let active = false;
    // Every worker's newest step, so steps that change nothing shown still count as progress.
    const progress: Array<string> = [];
    let totalTokens: number | undefined = 0;
    let toolCalls = 0;
    const agents: Array<OrchestrationV2WorkflowAgent> = [];
    for (const [index, [name, member]] of workers.slice(0, MAX_MEMBERS).entries()) {
      const conversationId = member.conversation_id;
      const activity =
        conversationId !== undefined && NATIVE_ID.test(conversationId)
          ? await readActivity(profileRoot, conversationId).catch(() => undefined)
          : undefined;
      progress.push(`${name}:${activity?.lastStep ?? ""}`);
      const brief = briefs.get(name);
      const result = results.get(name);
      const isKilled = killed(member);
      const state: OrchestrationV2WorkflowAgent["state"] =
        activity?.failed !== undefined
          ? "failed"
          : activity === undefined
            ? isKilled
              ? "completed"
              : "queued"
            : activity.ended || isKilled
              ? "completed"
              : "running";
      if (state === "running" || state === "queued") active = true;
      if (activity?.usage === undefined) totalTokens = undefined;
      else if (totalTokens !== undefined) {
        totalTokens += activity.usage.totalTokens;
        toolCalls += activity.usage.toolCalls;
      }
      const prompt = brief?.text.replace(/^@[A-Za-z0-9._-]+\s*/, "").trim();
      const resultText = (activity?.failed ?? result?.text)?.trim();
      const startedAt = activity?.startedAt ?? epochMillis(brief?.time);
      const completedAt =
        state === "failed"
          ? activity?.lastAt
          : state === "completed"
            ? (epochMillis(result?.time) ?? activity?.lastAt)
            : undefined;
      const model = memberModel(member);
      agents.push({
        index,
        label: name,
        ...(conversationId === undefined || conversationId === ""
          ? {}
          : { agentId: conversationId }),
        state,
        ...(model === undefined ? {} : { model }),
        ...activity?.usage,
        ...(startedAt === undefined ? {} : { startedAt }),
        ...(completedAt === undefined ? {} : { completedAt }),
        ...(prompt === undefined || prompt === "" ? {} : { prompt: capText(prompt) }),
        ...(resultText === undefined || resultText === "" ? {} : { result: capText(resultText) }),
      });
    }
    // Workers past the cap are not shown, but one queued or at work keeps the swarm active.
    for (const [, member] of workers.slice(MAX_MEMBERS)) {
      if (killed(member)) continue;
      const conversationId = member.conversation_id;
      const activity =
        conversationId !== undefined && NATIVE_ID.test(conversationId)
          ? await readActivity(profileRoot, conversationId).catch(() => undefined)
          : undefined;
      progress.push(`${activity?.lastStep ?? ""}`);
      if (activity === undefined || (!activity.ended && activity.failed === undefined)) {
        active = true;
      }
    }
    const title = roster.title?.trim();
    return {
      workflow: {
        ...(title === undefined || title === "" ? {} : { name: title }),
        phases: [],
        agents,
        ...(agents.length === 0 || totalTokens === undefined ? {} : { totalTokens, toolCalls }),
      },
      prompt: agents
        .flatMap((agent) => (agent.prompt === undefined ? [] : [`@${agent.label} ${agent.prompt}`]))
        .join("\n\n"),
      active,
      progress: progress.join(","),
    };
  };
  // An unreadable board means no swarm view this poll; the next poll reads again.
  return yield* Effect.tryPromise({
    try: read,
    catch: (cause) => new AntigravitySwarmReadError({ cause }),
  }).pipe(Effect.orElseSucceed((): AntigravitySwarmSnapshot | undefined => undefined));
});
