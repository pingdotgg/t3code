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
const TRANSCRIPT_TAIL_BYTES = 64 * 1024;
const MAX_MEMBERS = 64;
const TEXT_CAP = 4_000;
// The swarm's own helpers, not task workers; the board view leaves them out the same way.
const SUPPORT_ROLE = /^(narrator|monitor)(-\d+)?$/;
const DONE_MARK = /\[done\]/i;

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
  type: Schema.String,
  status: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  created_at: Schema.optional(Schema.String),
  input_tokens: Schema.optional(Schema.Number),
  output_tokens: Schema.optional(Schema.Number),
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
    const buffer = Buffer.alloc(stat.size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8", 0, bytesRead);
    // A cut first line is not a whole record.
    return start === 0
      ? { text, whole: true }
      : { text: text.slice(text.indexOf("\n") + 1), whole: false };
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
  const tail = await readTail(file.path, TRANSCRIPT_TAIL_BYTES).catch(() => undefined);
  if (tail === undefined) return undefined;
  const steps = lines(tail.text, decodeStep);
  const last = steps.at(-1);
  let tokens = 0;
  let toolCalls = 0;
  for (const step of steps) {
    tokens += (step.input_tokens ?? 0) + (step.output_tokens ?? 0);
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
    usage: tail.whole ? { totalTokens: tokens, toolCalls } : undefined,
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
  /** Board head, so callers can skip unchanged snapshots cheaply. */
  readonly head: number;
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
    if (rosterFile === undefined || rosterFile.info.size > MAX_ROSTER_BYTES) return undefined;
    const roster = Option.getOrUndefined(
      decodeRoster(await NodeFSP.readFile(rosterFile.path, "utf8")),
    );
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
      )
      .slice(0, MAX_MEMBERS);
    let active = false;
    let totalTokens: number | undefined = 0;
    let toolCalls = 0;
    const agents: Array<OrchestrationV2WorkflowAgent> = [];
    for (const [index, [name, member]] of workers.entries()) {
      const conversationId = member.conversation_id;
      const activity =
        conversationId !== undefined && NATIVE_ID.test(conversationId)
          ? await readActivity(profileRoot, conversationId).catch(() => undefined)
          : undefined;
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
        state === "completed" || state === "failed"
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
      head: board.at(-1)?.seq ?? 0,
    };
  };
  // An unreadable board means no swarm view this poll; the next poll reads again.
  return yield* Effect.tryPromise({
    try: read,
    catch: (cause) => new AntigravitySwarmReadError({ cause }),
  }).pipe(Effect.orElseSucceed((): AntigravitySwarmSnapshot | undefined => undefined));
});
