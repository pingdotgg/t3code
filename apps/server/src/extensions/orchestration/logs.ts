// @effect-diagnostics nodeBuiltinImport:off - agent log sources are host files read at the adapter boundary.
/**
 * `t3.orchestration/logs@1.0.0` — read-only agent log/output inspection.
 *
 * Sources come from the thread's own folded roster (`outputFile`); callers
 * name a roster id, never a path, and results never carry a host path.
 * Containment is bound to the run: the handle must sit in a session directory
 * `<root>/<workspace slug>/<session>/` as written, its directory must resolve
 * to that same place, and it may resolve only to itself or to that session's
 * transcript for the same run
 * (`<root>/<slug>/<session>/subagents/agent-<id>.jsonl`, Claude's layout).
 * The file is opened without following a final symlink, then the opened
 * object is re-verified against that location. Contents are secret-scrubbed
 * (`logRedaction.ts`) before the byte and line budgets apply. Failures are
 * fixed `AgentLogs*` codes that never interpolate paths or contents.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { AuthOrchestrationReadScope, ExtensionOperationError, ThreadId } from "@t3tools/contracts";
import { foldSubagentRoster } from "@t3tools/client-runtime/state/subagentRuntime";
import {
  AGENT_LOG_TAIL_MAX_BYTES,
  AGENT_LOG_TAIL_MAX_LINES,
  AGENT_LOG_TITLE_MAX_LENGTH,
  ORCHESTRATION_LOGS_API,
  type AgentLogRun,
  type AgentLogRuns,
  type AgentLogTail,
} from "@t3tools/extension-sdk/catalogue";
import type { ViewContext } from "@t3tools/extension-sdk/contracts";
import type { HostApiInvocationMetadata, HostApiProvider } from "@t3tools/extension-runtime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeExtensionScopeResolver } from "../scope.ts";
import { boundedPrefix } from "../vcsDiffApi.ts";
import { keyStateAfter, redactLogSecrets, type KeyStart } from "./logRedaction.ts";

const fail = (detail: string) =>
  new ExtensionOperationError({ operation: "orchestration.logs", detail });
const isOperationError = Schema.is(ExtensionOperationError);
const isEmptyObject = (input: unknown) =>
  typeof input === "object" &&
  input !== null &&
  !Array.isArray(input) &&
  Object.keys(input).length === 0;
const tailInput = Schema.decodeUnknownSync(
  Schema.Struct({
    runId: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(160)),
    source: Schema.Literal("output"),
    maxBytes: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: AGENT_LOG_TAIL_MAX_BYTES })),
    ),
    maxLines: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: AGENT_LOG_TAIL_MAX_LINES })),
    ),
  }),
  { onExcessProperty: "error" },
);
/**
 * Bytes read ahead of the delivered window so a secret straddling the tail
 * cut is redacted whole. A line that starts before them is withheld rather
 * than delivered unclassified (`shapeLogTail`).
 */
const AGENT_LOG_REDACTION_CONTEXT_BYTES = 8192;
/**
 * Bytes before the delivered lines read to learn whether they start inside a
 * private key (`keyStateBefore`). Keys are far smaller, so a BEGIN in them
 * without its END means the window starts inside one; with no marker at all,
 * the state is unknown and leading key-like lines are withheld.
 */
const AGENT_LOG_KEY_SCAN_BYTES = 256 * 1024;

/**
 * Directories the Claude harness writes agent output under: transcripts in
 * `~/.claude/projects`, task `.output` files (often symlinks into the former)
 * in `/tmp/claude-<uid>`. Missing roots are skipped.
 */
function defaultAgentLogRoots(): readonly string[] {
  const roots = [NodePath.join(NodeOS.homedir(), ".claude", "projects")];
  if (typeof process.getuid === "function") roots.push(`/tmp/claude-${process.getuid()}`);
  return roots;
}

/** Claude's per-workspace directory name: every non-alphanumeric becomes `-`. */
export const claudeWorkspaceSlug = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, "-");

/**
 * Whether the source continues inside a private key after `scan`, the bytes
 * directly before a line; `complete` when they reach the source's start.
 * Markers count in any form, and a BEGIN stays open until an END of its type.
 * With no marker in an incomplete scan the state is unknown.
 */
export const keyStateBefore = (scan: Uint8Array, complete: boolean): KeyStart =>
  keyStateAfter(new TextDecoder().decode(scan), complete ? "outside" : "unknown");

/**
 * Shapes a byte region that ends at the end of the source; `start` is its
 * offset in the source. `before` is the key state at its first whole line, or
 * the bytes directly before the region to find it in (`keyStateBefore`). A
 * region starting mid-source first drops its leading partial line: that
 * line's start (and any secret name on it) is unread, so redaction cannot
 * classify it, even when it is the only line. The rest is decoded and redacted, from the key state at its
 * first line: inside a key it is redacted through END, and where the state
 * is unknown its leading lines of possible key material are withheld. It is
 * then cut to `maxBytes` UTF-8 bytes. A cut inside a line drops leading UTF-8
 * continuation bytes and, when it holds a later line, its partial first line;
 * `maxLines` then keeps the last N lines.
 */
export function shapeLogTail(
  region: Uint8Array,
  start: number,
  limits: { readonly maxBytes: number; readonly maxLines: number },
  before: Uint8Array | KeyStart = new Uint8Array(),
): { readonly contents: string; readonly truncated: boolean } {
  const offset = start > 0 ? region.indexOf(0x0a) + 1 || region.length : 0;
  const key =
    start === 0
      ? "outside"
      : !(before instanceof Uint8Array)
        ? before
        : keyStateBefore(
            Buffer.concat([before, region.subarray(0, offset)]),
            before.length >= start,
          );
  let bytes = new TextEncoder().encode(
    redactLogSecrets(new TextDecoder().decode(region.subarray(offset)), { lineStart: true, key }),
  );
  // Earlier source bytes were withheld; the redacted bytes are cut only when
  // they overflow `maxBytes`.
  let truncated = start > 0;
  let cut = 0;
  if (bytes.length > limits.maxBytes) {
    const from = bytes.length - limits.maxBytes;
    // A cut exactly after a newline keeps whole lines; only a cut inside a
    // line leaves a partial first line to drop.
    const midLine = bytes[from - 1] !== 0x0a;
    bytes = bytes.subarray(from);
    truncated = true;
    if (midLine) {
      while (cut < bytes.length && (bytes[cut]! & 0xc0) === 0x80) cut++;
      const newline = bytes.indexOf(0x0a, cut);
      if (newline !== -1 && newline < bytes.length - 1) cut = newline + 1;
    }
  }
  let contents = new TextDecoder().decode(bytes.subarray(cut));
  const lines = contents.split("\n");
  const count = contents.endsWith("\n") ? lines.length - 1 : lines.length;
  if (count > limits.maxLines) {
    contents = lines.slice(count - limits.maxLines).join("\n");
    truncated = true;
  }
  return { contents, truncated };
}

type Dependencies = Parameters<typeof makeExtensionScopeResolver>[0] & {
  readonly snapshots: Pick<ProjectionSnapshotQuery["Service"], "getThreadDetailSnapshot">;
  readonly roots: () => readonly string[];
  /** Opens the contained source; tests interpose here to race the verification. */
  readonly open?: typeof NodeFSP.open;
};

const OPEN_FLAGS =
  NodeFSP.constants.O_RDONLY | NodeFSP.constants.O_NOFOLLOW | NodeFSP.constants.O_NONBLOCK;
/** Reads exactly `length` bytes at `position`; a short read means the file changed. */
async function readFully(file: NodeFSP.FileHandle, position: number, length: number) {
  const bytes = Buffer.alloc(length);
  const { bytesRead } = await file.read(bytes, 0, length, position);
  if (bytesRead !== length) throw fail("AgentLogsSourceChanged");
  return bytes;
}
const sameFile = (a: { ino: number; dev: number }, b: { ino: number; dev: number }) =>
  a.ino === b.ino && a.dev === b.dev;

export function createOrchestrationLogsApiProvider(deps: Dependencies): HostApiProvider {
  const resolve = makeExtensionScopeResolver(deps);
  const guard = async (
    context: ViewContext,
    signal: AbortSignal,
    metadata: HostApiInvocationMetadata,
  ) => {
    signal.throwIfAborted();
    if (
      metadata.principal?.environmentId !== deps.environmentId ||
      !metadata.principal.scopes.includes(AuthOrchestrationReadScope)
    )
      throw fail(`AgentLogsAuthorityDenied: ${AuthOrchestrationReadScope}`);
    if (!context.resource.threadId) throw fail("AgentLogsThreadScopeRequired");
    const scope = await Effect.runPromise(resolve(context), { signal });
    await metadata.assertAuthority?.();
    return scope;
  };
  const roster = async (threadId: string, signal: AbortSignal) => {
    const found = await Effect.runPromise(
      deps.snapshots.getThreadDetailSnapshot(ThreadId.make(threadId)),
      { signal },
    );
    if (Option.isNone(found) || found.value.thread.deletedAt !== null)
      throw fail("AgentLogsThreadUnavailable");
    const thread = found.value.thread;
    return foldSubagentRoster(thread.activities, {
      sessionLive:
        thread.session !== null &&
        !["stopped", "interrupted", "error"].includes(thread.session.status),
    });
  };
  /**
   * Real paths this run's handle may resolve to. The session and the handle's
   * place in it are bound from the handle as written, before any ancestor is
   * resolved, and its directory must resolve to that same place — an
   * ancestor aliased into another session cannot rebind the run.
   */
  const allowedTargets = async (handle: string, cwd: string) => {
    if (!NodePath.isAbsolute(handle)) throw fail("AgentLogsOutOfScope");
    const slugs = new Set([claudeWorkspaceSlug(cwd)]);
    await NodeFSP.realpath(cwd).then(
      (real) => slugs.add(claudeWorkspaceSlug(real)),
      () => undefined,
    );
    const roots = (
      await Promise.all(
        deps.roots().map(async (root) => {
          const real = await NodeFSP.realpath(root).catch(() => null);
          return real === null
            ? null
            : { real, spellings: new Set([NodePath.resolve(root), real]) };
        }),
      )
    ).filter((root) => root !== null);
    const directory = NodePath.dirname(handle);
    const name = NodePath.basename(handle);
    for (const root of roots)
      for (const spelling of root.spellings)
        for (const slug of slugs) {
          const base = NodePath.join(spelling, slug) + NodePath.sep;
          if (!(directory + NodePath.sep).startsWith(base)) continue;
          const [session, ...rest] = directory.slice(base.length).split(NodePath.sep);
          if (!session) continue;
          const bound = NodePath.join(root.real, slug, session, ...rest);
          const parent = await NodeFSP.realpath(directory).catch(() => {
            throw fail("AgentLogsSourceUnavailable");
          });
          if (parent !== bound) throw fail("AgentLogsOutOfScope");
          const run = name.slice(0, name.length - NodePath.extname(name).length);
          return new Set([
            NodePath.join(parent, name),
            ...roots.map((each) =>
              NodePath.join(each.real, slug, session, "subagents", `agent-${run}.jsonl`),
            ),
          ]);
        }
    throw fail("AgentLogsOutOfScope");
  };
  const readRegion = async (written: string, cwd: string, maxBytes: number) => {
    // `..` segments are resolved lexically first, so they bind like any path.
    const handle = NodePath.normalize(written);
    const allowed = await allowedTargets(handle, cwd);
    const resolved = await NodeFSP.realpath(handle).catch(() => {
      throw fail("AgentLogsSourceUnavailable");
    });
    if (!allowed.has(resolved)) throw fail("AgentLogsOutOfScope");
    const file = await (deps.open ?? NodeFSP.open)(resolved, OPEN_FLAGS).catch(() => {
      throw fail("AgentLogsSourceUnavailable");
    });
    try {
      // Verify the opened object, not the path: an ancestor swapped around the
      // open changes the path's realpath or its inode, and either fails here.
      const stat = await file.stat();
      if (!stat.isFile()) throw fail("AgentLogsSourceUnavailable");
      // Linux names the opened object directly; elsewhere realpath + lstat stand in.
      const opened = await NodeFSP.readlink(`/proc/self/fd/${file.fd}`).catch(() => null);
      const again = await NodeFSP.realpath(resolved);
      const pathStat = await NodeFSP.lstat(resolved);
      if (
        (opened !== null && opened !== resolved) ||
        again !== resolved ||
        !sameFile(stat, pathStat)
      )
        throw fail("AgentLogsSourceChanged");
      const start = Math.max(0, stat.size - maxBytes - AGENT_LOG_REDACTION_CONTEXT_BYTES);
      const region = await readFully(file, start, stat.size - start);
      // The key state comes from a fixed scan of the bytes before the first
      // whole line, re-read every call: nothing is cached to go stale.
      const lineStart = start + (region.indexOf(0x0a) + 1 || region.length);
      const from = Math.max(0, lineStart - AGENT_LOG_KEY_SCAN_BYTES);
      const scan =
        from >= start
          ? region.subarray(from - start, lineStart - start)
          : Buffer.concat([
              await readFully(file, from, start - from),
              region.subarray(0, lineStart - start),
            ]);
      const key = start === 0 ? ("outside" as const) : keyStateBefore(scan, from === 0);
      return { region, key, start, byteLength: stat.size };
    } catch (error) {
      // Raw filesystem errors carry host paths; only fixed codes leave here.
      if (isOperationError(error)) throw error;
      throw fail("AgentLogsSourceChanged");
    } finally {
      await file.close().catch(() => undefined);
    }
  };

  return {
    providerId: "t3.host-orchestration-logs",
    definition: ORCHESTRATION_LOGS_API,
    requiresRootAuthority: true,
    async invoke(method, input, context, signal, metadata) {
      const scope = await guard(context, signal, metadata);
      const threadId = context.resource.threadId!;
      if (method === "listRuns") {
        if (!isEmptyObject(input)) throw fail("AgentLogsInvalidInput");
        const { agents, evicted } = await roster(threadId, signal);
        const toRun = (agent: (typeof agents)[number]): AgentLogRun | null =>
          agent.outputFile && agent.id.length <= 160
            ? {
                runId: agent.id,
                kind: agent.kind,
                title: boundedPrefix(agent.title, AGENT_LOG_TITLE_MAX_LENGTH),
                status: agent.status,
                sources: ["output"],
              }
            : null;
        const result: AgentLogRuns = {
          runs: agents.map(toRun).filter((run) => run !== null),
          // The fold's retention cap evicts runs the roster stream never shows.
          truncated: evicted.some((agent) => toRun(agent) !== null),
        };
        return result;
      }
      if (method !== "readTail") throw fail(`AgentLogsUnsupported: ${method}`);
      let safe: ReturnType<typeof tailInput>;
      try {
        safe = tailInput(input);
      } catch {
        throw fail("AgentLogsInvalidInput");
      }
      const agent = (await roster(threadId, signal)).agents.find((item) => item.id === safe.runId);
      if (!agent) throw fail("AgentLogsRunUnknown");
      if (!agent.outputFile) throw fail("AgentLogsSourceUnavailable");
      const maxBytes = safe.maxBytes ?? AGENT_LOG_TAIL_MAX_BYTES;
      const read = await readRegion(agent.outputFile, scope.cwd, maxBytes);
      // A session revoked mid-read never receives the bytes.
      await guard(context, signal, metadata);
      const shaped = shapeLogTail(
        read.region,
        read.start,
        { maxBytes, maxLines: safe.maxLines ?? AGENT_LOG_TAIL_MAX_LINES },
        read.key,
      );
      if (Buffer.byteLength(shaped.contents) > maxBytes) throw fail("AgentLogsTailTooLarge");
      const result: AgentLogTail = {
        runId: agent.id,
        source: "output",
        contents: shaped.contents,
        byteLength: read.byteLength,
        truncated: shaped.truncated,
      };
      return result;
    },
  };
}

export const makeOrchestrationLogsApiProvider = Effect.fn("OrchestrationLogsApi.make")(
  function* () {
    const environment = yield* ServerEnvironment;
    return createOrchestrationLogsApiProvider({
      environmentId: yield* environment.getEnvironmentId,
      projects: yield* ProjectionProjectRepository,
      threads: yield* ProjectionThreadRepository,
      snapshots: yield* ProjectionSnapshotQuery,
      roots: defaultAgentLogRoots,
    });
  },
);
