/**
 * AgentSessionRegistry - Root PIDs of per-thread provider session processes.
 *
 * Providers whose session maps 1:1 to a spawned CLI process (Claude via the
 * Agent SDK spawn hook, Cursor and Grok via ACP) register the child PID here
 * so the port scanner can attribute listening descendants to the owning
 * thread and thread deletion can clean the tree up. Providers that share one
 * server process across threads (Codex app-server, OpenCode server) must NOT
 * register — attributing their listeners to a single thread would be wrong.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export interface AgentSessionRoot {
  readonly threadId: string;
  readonly pid: number;
}

export class AgentSessionRegistry extends Context.Service<
  AgentSessionRegistry,
  {
    /** Register the root process of a thread's provider session. */
    readonly register: (input: AgentSessionRoot) => Effect.Effect<void>;
    /**
     * Drop a thread's registration. When `pid` is given, only that exact
     * registration is removed (a restarted session may already own a new pid).
     */
    readonly unregister: (input: {
      readonly threadId: string;
      readonly pid?: number;
    }) => Effect.Effect<void>;
    /** Current root pid per thread. */
    readonly snapshot: Effect.Effect<ReadonlyMap<number, string>>;
    /** Root pid registered for one thread, if any. */
    readonly rootForThread: (threadId: string) => Effect.Effect<number | null>;
  }
>()("t3/process/AgentSessionRegistry") {}

export const make = Effect.gen(function* () {
  const rootsRef = yield* Ref.make<ReadonlyMap<string, number>>(new Map());

  const register: AgentSessionRegistry["Service"]["register"] = (input) =>
    Ref.update(rootsRef, (roots) => {
      if (!Number.isInteger(input.pid) || input.pid <= 0) return roots;
      const next = new Map(roots);
      next.set(input.threadId, input.pid);
      return next;
    });

  const unregister: AgentSessionRegistry["Service"]["unregister"] = (input) =>
    Ref.update(rootsRef, (roots) => {
      const current = roots.get(input.threadId);
      if (current === undefined) return roots;
      if (input.pid !== undefined && current !== input.pid) return roots;
      const next = new Map(roots);
      next.delete(input.threadId);
      return next;
    });

  const snapshot: AgentSessionRegistry["Service"]["snapshot"] = Ref.get(rootsRef).pipe(
    Effect.map((roots) => {
      const byPid = new Map<number, string>();
      for (const [threadId, pid] of roots) byPid.set(pid, threadId);
      return byPid;
    }),
  );

  const rootForThread: AgentSessionRegistry["Service"]["rootForThread"] = (threadId) =>
    Ref.get(rootsRef).pipe(Effect.map((roots) => roots.get(threadId) ?? null));

  return AgentSessionRegistry.of({ register, unregister, snapshot, rootForThread });
});

export const layer = Layer.effect(AgentSessionRegistry, make);
