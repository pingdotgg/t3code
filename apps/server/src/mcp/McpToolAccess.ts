import {
  OrchestratorMcpFailure,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Struct from "effect/Struct";
import type * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type { Tool, Toolkit } from "effect/ai";

import {
  DispatchModeLimit,
  type DispatchModeRefusal,
} from "../orchestration-v2/DispatchModeLimit.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { resolveInteractionMode, resolveRuntimeMode } from "./OrchestratorMcpService.ts";
import {
  assertFullAccess,
  assertLiveCaller,
  assertTargetWithinLimits,
  type Caller,
  loadCaller,
  readCaller,
  unavailable,
} from "./threadAccess.ts";

// Only the classes below assign these, from their static blocks, so nothing
// outside this module can build a declaration or a handlers layer.

/**
 * Both constructors demand this. Their private constructors only stop the type
 * checker; this also stops `Reflect.construct` and friends at runtime.
 */
const builtHere: unique symbol = Symbol("t3/mcp/McpToolAccess/builtHere");

const refuseOutsideConstruction = (token: symbol) => {
  if (token !== builtHere) {
    throw new TypeError("Only McpToolAccess builds MCP tool declarations and handler layers.");
  }
};

/** Builds a declaration; only the declaration functions below call it. */
let declare: <P, A, E, R>(
  handle: (params: P) => Effect.Effect<A, E, R>,
) => Declaration<(params: P) => Effect.Effect<A, E, R>>;

type CheckedHandlerOf<D> = D extends Declaration<infer Handler> ? Handler : never;

/** Turns each declaration back into the handler it checks, keeping its type. */
interface CheckedHandler extends Struct.Lambda {
  <Handler>(declaration: Declaration<Handler>): Handler;
  readonly "~lambda.out": CheckedHandlerOf<this["~lambda.in"]>;
}
let checkedHandler: CheckedHandler;

/** Only `toLayer` below builds one. */
let handlersLayer: <Tools extends Record<string, Tool.Any>, EX, RX>(
  layer: Layer.Layer<Tool.HandlersFor<Tools>, EX, RX>,
) => HandlersLayer<Tools, EX, RX>;

/**
 * Who may call a T3 MCP tool. Every handler is built by one of the
 * declarations below, which say what the tool does. `toLayer` accepts only
 * declarations, and `/mcp` registers only layers `toLayer` built, so a tool
 * without a decision here does not compile. Both are nominal classes, so a
 * handler or layer cannot pass for one by copying its fields. Effect's own
 * registration functions accept any handler, so the
 * `t3code/no-raw-mcp-registration` lint rule keeps Effect's `McpServer` inside
 * McpHttpServer.
 *
 * Parameters choose the target; the caller sets the limits: a thread caller
 * its own runtime and interaction modes, an outside client the ceiling it was
 * approved with. Nothing a caller starts or changes may run with broader
 * modes, and a thread caller changes things only while its own run is live.
 * A refusal is an `OrchestratorMcpFailure`, so the compiler requires it in the
 * tool's failure schema, and `ThreadManagementService` in its dependencies.
 *
 * The declaration checks the caller before the handler runs. Handlers still
 * check what only they can see, such as a queued run belonging to its thread.
 */
export class Declaration<out Handler> {
  // A private field makes the class nominal, and only this module can build
  // one: its constructor is private and the static block hands the only way
  // in to module-scoped functions. Copying a declaration's fields onto
  // anything else fails to typecheck and, at runtime, to run.
  readonly #handle: Handler;
  private constructor(token: typeof builtHere, handle: Handler) {
    refuseOutsideConstruction(token);
    this.#handle = handle;
  }
  static {
    declare = (handle) => new Declaration(builtHere, handle);
    checkedHandler = Struct.lambda<CheckedHandler>((declaration) => declaration.#handle);
  }
}

/**
 * The caller of a tool that changes something. Tools that act for a
 * capability of their own (preview, device, worktree, pull requests) check it
 * themselves.
 */
const writingCaller = loadCaller().pipe(Effect.tap(assertLiveCaller));

/** The same, for tools whose only capability is controlling threads. */
const orchestratingCaller = readCaller().pipe(Effect.tap(assertLiveCaller));

const requireThreadCaller = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, "This tool")),
);

/** Changes nothing, so every caller may call it. */
export const reads = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) => handle(params));

/** Reads what belongs to the calling T3 thread, such as its preview tabs or devices. */
export const readsAsCaller = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) => requireThreadCaller.pipe(Effect.flatMap(() => handle(params))));

/**
 * Acts as the calling T3 thread (its subagents, preview tabs, devices,
 * worktree) while that thread's run is live. Only an agent running inside a
 * T3 thread has one.
 */
export const actsAsCaller = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) =>
    requireThreadCaller.pipe(
      Effect.flatMap(() => writingCaller),
      Effect.flatMap(() => handle(params)),
    ),
  );

/** Changes something that belongs to no thread, such as a pending upload or a scheduled task. */
export const writes = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) => orchestratingCaller.pipe(Effect.flatMap(() => handle(params))));

/**
 * Changes the threads `threads` names. An omitted id is the caller's own
 * thread; any other thread must run within the caller's modes, checked here
 * and again by the orchestrator when it applies each command. A thread that
 * does not exist is the handler's to report.
 */
export const writesThreads = <P, A, E, R>(
  threads: (params: P) => ReadonlyArray<ThreadId | undefined>,
  handle: (params: P) => Effect.Effect<A, E, R>,
) =>
  declare((params: P) =>
    Effect.gen(function* () {
      const caller = yield* writingCaller;
      for (const threadId of threads(params)) {
        if (threadId === undefined || threadId === caller.scope.thread?.threadId) continue;
        const target = yield* caller.threads
          .getThreadShell(threadId)
          .pipe(Effect.mapError(unavailable));
        if (target !== null && target.deletedAt === null) {
          yield* assertTargetWithinLimits(caller.limits, target);
        }
      }
      // The target's user can raise its modes after the check above; the
      // orchestrator checks again under the thread's lock and records its
      // refusal here, since handlers wrap dispatch errors their own way.
      const refused = yield* Ref.make<DispatchModeRefusal | undefined>(undefined);
      return yield* handle(params).pipe(
        Effect.provideService(DispatchModeLimit, { ...caller.limits, refused }),
        Effect.catch((error) =>
          Effect.flatMap(Ref.get(refused), (refusal) =>
            Effect.fail<E | OrchestratorMcpFailure>(
              refusal === undefined ? error : escalationDenied(refusal),
            ),
          ),
        ),
      );
    }),
  );

/** How an agent hears that a thread it targets was raised above its modes mid-call. */
const escalationDenied = (refusal: DispatchModeRefusal) =>
  new OrchestratorMcpFailure({
    code:
      refusal.mode === "runtime"
        ? "runtime_mode_escalation_denied"
        : "interaction_mode_escalation_denied",
    message: `Thread ${refusal.threadId} now runs in ${refusal.runtimeMode}/${refusal.interactionMode} mode, above this caller's. Its user changed it while this call ran.`,
  });

/** The modes a started thread runs with: those requested, else the caller's own. */
export interface StartedModes {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

/** Starts threads with the modes `modes` requests, which may not be broader than the caller's. */
export const startsThreads = <P, A, E, R>(
  modes: (params: P) => {
    readonly runtimeMode?: RuntimeMode | undefined;
    readonly interactionMode?: ProviderInteractionMode | undefined;
  },
  handle: (params: P, modes: StartedModes) => Effect.Effect<A, E, R>,
) =>
  declare((params: P) =>
    Effect.gen(function* () {
      const { limits } = yield* writingCaller;
      const requested = modes(params);
      const started: StartedModes = {
        runtimeMode: yield* resolveRuntimeMode(limits.runtimeMode, requested.runtimeMode),
        interactionMode: yield* resolveInteractionMode(
          limits.interactionMode,
          requested.interactionMode,
        ),
      };
      return yield* handle(params, started);
    }),
  );

const fullAccessRequired =
  "Changing projects or environment settings needs a live full-access/default calling thread or a full-access client.";

/**
 * Changes projects or environment settings, which needs a full-access/default
 * caller. `check` re-checks the caller wherever the handler waits before
 * writing, such as for a lock, since the caller's modes can change meanwhile.
 */
export const writesEnvironment = <P, A, E, R>(
  handle: (
    params: P,
    check: Effect.Effect<Caller, OrchestratorMcpFailure, CheckServices>,
  ) => Effect.Effect<A, E, R>,
) => {
  const check = orchestratingCaller.pipe(
    Effect.tap((caller) => assertFullAccess(caller, fullAccessRequired)),
  );
  return declare((params: P) => check.pipe(Effect.flatMap(() => handle(params, check))));
};

/** What a declaration's own check needs. */
type CheckServices = Effect.Services<typeof orchestratingCaller>;

/**
 * Each handler of `Handlers`, built by one of the declarations above. A
 * declaration is never callable, which rules out a handler function wearing a
 * declaration's fields.
 */
type Declarations<Handlers> = {
  readonly [Name in keyof Handlers]: Declaration<Handlers[Name]> & NotCallable;
};

/** Anything but a function. */
type NotCallable = { readonly call?: never } & { readonly apply?: never };

/** A toolkit's handlers, each built by one of the declarations above. */
export type Handlers<Tools extends Record<string, Tool.Any>> = Declarations<
  Toolkit.HandlersFrom<Tools>
>;

/**
 * A toolkit's handler layer built by `toLayer`, the only kind `/mcp`
 * registers. Like a declaration it is nominal, so nothing else passes for one.
 */
export class HandlersLayer<Tools extends Record<string, Tool.Any>, EX = never, RX = never> {
  readonly #layer: Layer.Layer<Tool.HandlersFor<Tools>, EX, RX>;
  private constructor(
    token: typeof builtHere,
    layer: Layer.Layer<Tool.HandlersFor<Tools>, EX, RX>,
  ) {
    refuseOutsideConstruction(token);
    this.#layer = layer;
  }
  static {
    handlersLayer = (layer) => new HandlersLayer(builtHere, layer);
  }
  /** The handlers, for registering this toolkit on the MCP server. */
  static layer<Tools extends Record<string, Tool.Any>, EX, RX>(
    handlers: HandlersLayer<Tools, EX, RX>,
  ) {
    return handlers.#layer;
  }
}

const checkedHandlers = <Handlers>(declarations: Declarations<Handlers>): Handlers =>
  Struct.map(declarations, checkedHandler);

/** `Toolkit.toLayer` for handlers that all declare their access. */
export const toLayer = <Tools extends Record<string, Tool.Any>, EX = never, RX = never>(
  toolkit: Toolkit.Toolkit<Tools>,
  build: Handlers<Tools> | Effect.Effect<Handlers<Tools>, EX, RX>,
): HandlersLayer<Tools, EX, Exclude<RX, Scope.Scope>> =>
  handlersLayer(
    toolkit.toLayer(
      Effect.isEffect(build)
        ? Effect.map(build, checkedHandlers<Toolkit.HandlersFrom<Tools>>)
        : checkedHandlers(build),
    ),
  );
