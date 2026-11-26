import {
  type EnvironmentId,
  isRuntimeModeAbove,
  type OrchestrationV2LinkOrigin,
  type OrchestrationV2ThreadShell,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  type ProviderApprovalPushHooks,
  type ProviderApprovalToolAction,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Struct from "effect/Struct";
import type * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import { McpSchema } from "effect/ai";
import type { Tool, Toolkit } from "effect/ai";

import {
  DispatchModeLimit,
  type DispatchModeRefusal,
} from "../orchestration-v2/DispatchModeLimit.ts";
import { hashToolInput } from "@t3tools/provider-core/server/McpProviderSessions";

import * as PeerForwarding from "../peer/PeerForwarding.ts";
import {
  assertFullAccessNamingLink,
  assertNotLinked,
  assertSameLink,
  callerLinkOrigin,
} from "./linkOrigin.ts";
import * as McpClientInput from "./McpClientInput.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpThreadApproval from "./McpThreadApproval.ts";
import { resolveInteractionMode, resolveRuntimeMode } from "./delegatedTaskModes.ts";
import {
  assertBroadestAccess,
  assertFullAccess,
  assertLiveCaller,
  assertTargetWithinLimits,
  type Caller,
  loadCaller,
  readCaller,
  unavailable,
} from "./threadAccess.ts";

/** Private constructors only enforce types; the token also blocks runtime construction. */
const builtHere: unique symbol = Symbol("t3/mcp/McpToolAccess/builtHere");

const refuseOutsideConstruction = (token: symbol) => {
  if (token !== builtHere) {
    throw new TypeError("Only McpToolAccess builds MCP tool declarations and handler layers.");
  }
};

let declare: <P, A, E, R>(
  handle: (params: P) => Effect.Effect<A, E, R>,
  remote: RemoteCheck<P> | undefined,
  forwarded?: Forwarded<P, A, E, R>,
) => Declaration<(params: P) => Effect.Effect<A, E, R>>;

/**
 * What a call bound for a linked environment checks here before it goes: the
 * caller, not the thread or project it names, which live there and are
 * checked there. `undefined` for tools that act as the calling thread itself.
 */
type RemoteCheck<P> = (
  params: P,
) => Effect.Effect<unknown, OrchestratorMcpFailure, Effect.Services<typeof writingCaller>>;
let remoteCheckOf: <Handler>(declaration: Declaration<Handler>) => RemoteCheck<never> | undefined;

/** What a call answered in a linked environment does here before it returns. */
type Forwarded<P, A, E, R> = (
  params: P,
  environmentId: EnvironmentId,
  result: A,
) => Effect.Effect<A, E, R>;
let forwardedOf: <Handler>(
  declaration: Declaration<Handler>,
) => Forwarded<never, unknown, unknown, unknown> | undefined;

type CheckedHandlerOf<D> = D extends Declaration<infer Handler> ? Handler : never;

interface CheckedHandler extends Struct.Lambda {
  <Handler>(declaration: Declaration<Handler>): Handler;
  readonly "~lambda.out": CheckedHandlerOf<this["~lambda.in"]>;
}
let checkedHandler: CheckedHandler;

let handlersLayer: <Tools extends Record<string, Tool.Any>, EX, RX>(
  layer: Layer.Layer<Tool.HandlersFor<Tools>, EX, RX>,
) => HandlersLayer<Tools, EX, RX>;

/** t3code/no-raw-mcp-registration confines Effect's unchecked registration API to McpHttpServer. */
export class Declaration<out Handler> {
  readonly #handle: Handler;
  readonly #remote: RemoteCheck<never> | undefined;
  readonly #forwarded: Forwarded<never, unknown, unknown, unknown> | undefined;
  private constructor(
    token: typeof builtHere,
    handle: Handler,
    remote: RemoteCheck<never> | undefined,
    forwarded: Forwarded<never, unknown, unknown, unknown> | undefined,
  ) {
    refuseOutsideConstruction(token);
    this.#handle = handle;
    this.#remote = remote;
    this.#forwarded = forwarded;
  }
  static {
    declare = (handle, remote, forwarded) =>
      new Declaration(
        builtHere,
        handle,
        remote,
        forwarded as Forwarded<never, unknown, unknown, unknown> | undefined,
      );
    checkedHandler = Struct.lambda<CheckedHandler>((declaration) => declaration.#handle);
    remoteCheckOf = (declaration) => declaration.#remote;
    forwardedOf = (declaration) => declaration.#forwarded;
  }
}

const refuseReadOnlyClient = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) =>
    scope.client?.access === "read-only"
      ? Effect.fail(
          new OrchestratorMcpFailure({
            code: "capability_denied",
            message:
              "This tool changes the environment, and this MCP client was approved for read-only access.",
          }),
        )
      : Effect.void,
  ),
);

const writingCaller = refuseReadOnlyClient.pipe(
  Effect.andThen(loadCaller()),
  Effect.tap(assertLiveCaller),
);

const orchestratingCaller = refuseReadOnlyClient.pipe(
  Effect.andThen(readCaller()),
  Effect.tap(assertLiveCaller),
);

const requireThreadCaller = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, "This tool")),
);

export const reads = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare(
    (params: P) => handle(params),
    () => Effect.void,
  );

export const readsAsCaller = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) => requireThreadCaller.pipe(Effect.flatMap(() => handle(params))), undefined);

export const actsAsCaller = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare(
    (params: P) =>
      requireThreadCaller.pipe(
        Effect.andThen(writingCaller),
        Effect.flatMap(() => handle(params)),
      ),
    undefined,
  );

/**
 * Acts for its own thread like `actsAsCaller`, and below Full access asks the person first when
 * `leaves` names something the call would send out of the thread, as a page upload of a file
 * from elsewhere does. A call that sends nothing out runs unasked.
 */
export const actsAsCallerAsking = <P, A, E, R, E2, R2>(
  tool: string,
  leaves: (
    params: P,
    caller: OrchestrationV2ThreadShell,
  ) => Effect.Effect<OutsideAction | undefined, E2, R2>,
  handle: (params: P) => Effect.Effect<A, E, R>,
) =>
  declare(
    (params: P) =>
      Effect.gen(function* () {
        yield* requireThreadCaller;
        const caller = yield* writingCaller;
        if (!hasFullAccess(caller) && caller.caller !== undefined) {
          const asks = yield* leaves(params, caller.caller);
          if (asks !== undefined) yield* personApproves(caller, tool, params, asks);
        }
        return yield* handle(params);
      }),
    undefined,
  );

/**
 * Changes something that belongs to no thread, such as a pending upload or a
 * scheduled task. Work a linked environment started may not: none of it
 * carries the link's origin, so none of it is that link's.
 */
export const writes = <P, A, E, R>(
  handle: (params: P) => Effect.Effect<A, E, R>,
  options?: {
    /** Whether a linked caller may make it, as for uploads its own sends need. */
    readonly linkedCallers?: "allowed";
  },
) =>
  declare(
    (params: P) =>
      orchestratingCaller.pipe(
        Effect.tap((caller) =>
          options?.linkedCallers === "allowed"
            ? Effect.void
            : assertNotLinked(caller, "change this environment's scheduled tasks"),
        ),
        Effect.flatMap(() => handle(params)),
      ),
    () => orchestratingCaller,
  );

/**
 * Drives work that runs for this environment's owner in modes its definition picks, such as a
 * workflow run. `what` names it in a refusal, after "can" or "cannot".
 */
export const writesOwnerWork = <P, A, E, R>(
  what: string,
  handle: (params: P) => Effect.Effect<A, E, R>,
) => {
  const check = orchestratingCaller.pipe(
    Effect.tap((caller) => assertNotLinked(caller, what)),
    Effect.tap((caller) => assertBroadestAccess(caller, what)),
  );
  return declare(
    (params: P) => check.pipe(Effect.flatMap(() => handle(params))),
    () => check,
  );
};

/** Requires handler capability checks, not thread control; linked work is refused the same way. */
export const writesWithCapability = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare(
    (params: P) =>
      writingCaller.pipe(
        Effect.tap((caller) => assertNotLinked(caller, startsOutsideWork)),
        Effect.flatMap(() => handle(params)),
      ),
    () => writingCaller,
  );

/**
 * What a tool is about to do outside its thread: a write to a forge with the user's login, or a
 * file of theirs sent to a page. The person asked to approve it reads these words. The server
 * writes the sentence; a name that comes from the call's arguments, a repository or a page is
 * put in it with `quoted`, as data.
 */
export interface OutsideAction extends Omit<ProviderApprovalToolAction, "tool"> {
  /** What else the approval covers, ending the question: the hooks a push would run. */
  readonly also?: string | undefined;
  readonly pushHooks?: ProviderApprovalPushHooks | undefined;
  /**
   * What the approval is for beyond what the words carry whole, such as full commit ids. Never
   * shown. An answer counts only while this and every word above read the same, so whatever
   * the action depends on belongs in one of the two.
   */
  readonly binds?: unknown;
}

// Drawn as nothing or as a space, or reordering what follows: controls, format characters,
// unassigned and private-use code points, lone surrogates, and every space but U+0020.
const UNSEEN = /[\p{C}\p{Zl}\p{Zp}\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufffc]/gu;

/** `text` on one line with nothing in it a screen would hide, and no longer than `max`. */
const visible = (text: string, max: number) => {
  const seen = Array.from(
    text.replace(UNSEEN, (character) => `\\u{${character.codePointAt(0)!.toString(16)}}`),
  );
  return seen.length > max ? `${seen.slice(0, max).join("")}…` : seen.join("");
};

/**
 * A value the server did not write, as it goes into a question: in quotation marks, on one
 * line, cut at `max` characters, with any character a screen would hide written out as its code
 * point. It reads as a name inside the sentence and never as more of the sentence.
 */
export const quoted = (value: string, max = 120) =>
  `"${visible(value.replace(/[\\"]/g, "\\$&"), max)}"`;

/** The last check on every word a person is shown, whatever the handler put in it. */
const shownAction = (asks: OutsideAction): OutsideAction => ({
  ...asks,
  action: visible(asks.action, 600),
  target: visible(asks.target, 600),
  ...(asks.repository === undefined ? {} : { repository: visible(asks.repository, 200) }),
  ...(asks.host === undefined ? {} : { host: visible(asks.host, 200) }),
  ...(asks.origin === undefined ? {} : { origin: visible(asks.origin, 200) }),
  ...(asks.also === undefined ? {} : { also: visible(asks.also, 2000) }),
  ...(asks.pushHooks === undefined
    ? {}
    : {
        pushHooks: {
          branch: visible(asks.pushHooks.branch, 200),
          files: asks.pushHooks.files.map((file) => visible(file, 400)),
          commands: asks.pushHooks.commands.map(({ name, command }) => ({
            name: visible(name, 200),
            command: visible(command, 400),
          })),
        },
      }),
});

const OUTSIDE_ACTION_KEY = "outside-action";

const outsideActionSentence = (asks: OutsideAction) =>
  `${asks.action} ${asks.target}${
    asks.repository !== undefined
      ? ` in ${asks.repository}`
      : asks.origin !== undefined
        ? ` to ${asks.origin}`
        : ""
  }${asks.also ?? ""}`;

const outsideActionRefused = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });

/**
 * Full access as the rest of the server reads it: the mode itself, outside plan mode, and not
 * above an administrator's limit, under which a thread recorded in Full access does not run in it.
 */
const hasFullAccess = ({ limits, scope }: Caller) =>
  limits.runtimeMode === "full-access" &&
  limits.interactionMode === "default" &&
  !isRuntimeModeAbove(limits.runtimeMode, scope.runtimeModeCeiling);

/**
 * What one approval is for. Of what the call resolved to, not of how it is shown: two values
 * that read alike once cut or written out are still two requests.
 */
const requestOf = (tool: string, params: unknown, resolved: OutsideAction) =>
  hashToolInput({ tool, params, asks: resolved });

/**
 * Below Full access, ends unless the person approved exactly this: the tool, its arguments and
 * what they resolved to; then returns the request they approved. The approval is read from
 * the server's own record of the person's answer in the thread, never from the client's word.
 * Anything that differs on the call that brings the answer is another request, and asks again.
 */
const personApproves = Effect.fnUntraced(function* (
  caller: Caller,
  tool: string,
  params: unknown,
  resolved: OutsideAction,
) {
  if (hasFullAccess(caller)) return;
  const asks = shownAction(resolved);
  const sentence = outsideActionSentence(asks);
  if (caller.caller === undefined) {
    return yield* outsideActionRefused(
      `Not done: "${sentence}" needs full access for this MCP client, which has no thread where a person could approve it.`,
    );
  }
  const cannotAsk = outsideActionRefused(
    `Not done: "${sentence}" needs the user's approval below Full access, and this agent's client cannot ask for it. Tell the user; they can do it themselves or switch this thread to Full access.`,
  );
  const { also: _also, binds: _binds, pushHooks, ...named } = asks;
  const request = requestOf(tool, params, resolved);
  const asking = {
    state: `${tool} ${request}`,
    // The start of the request's own name ends the question, so two requests never read alike
    // and an answer in the app is recorded for the one it was given to.
    message: `${sentence}? (request ${request.slice(0, 8)})`,
    toolAction: { tool, ...named },
    pushHooks,
  };
  // By elicitation where the thread's adapter passes on what the person answered; anywhere
  // else, and where that client takes no elicitation, in a request the server shows itself.
  const elicited = (yield* McpClientInput.asksThePerson)
    ? yield* McpClientInput.askApproval({ key: OUTSIDE_ACTION_KEY, ...asking })
    : "unavailable";
  const answer =
    elicited === "unavailable" ? yield* McpThreadApproval.ask(caller, asking) : elicited;
  switch (answer) {
    case "accepted":
      return { request, sentence };
    case "declined":
      return yield* outsideActionRefused(`Not done: the user declined "${sentence}".`);
    case "unconfirmed":
      return yield* outsideActionRefused(
        `Not done: T3 Code has no approval from the user for "${sentence}". Call again to ask.`,
      );
    case "unavailable":
      return yield* cannotAsk;
    case "waiting":
      return yield* outsideActionRefused(
        `Not done yet: T3 Code is asking the user to approve "${sentence}" in this thread, and they have not answered. Call again with the same arguments to wait for their answer.`,
      );
    case "asked":
      // Never read: the question is this call's answer.
      return yield* outsideActionRefused("Waiting for the user's approval.");
  }
});

const startsOutsideWork = "start work here that is not its link's";

/**
 * A call bound for a linked environment acts on a checkout and a forge login that are there, so
 * only that environment can say what it would do, and it has nobody to ask. Until it can hand
 * that back to be asked about here, the call goes only from a thread nobody needs to be asked for.
 */
const LINKED_NEEDS_FULL_ACCESS =
  "Not done: below Full access the user approves this action first, and T3 Code cannot yet show them what it would do in a linked environment. Nothing was sent there. Tell the user; they can do it themselves, or from a thread in that environment.";

/**
 * Acts outside the thread with the user's own access, as a forge write does. Below Full access
 * the person approves first. `plan` checks the arguments and resolves all the action depends
 * on into `asks`; `run` acts on that and compares anything it must read again, doing nothing
 * when it differs.
 */
export const actsOutsideThread = <P, A, E, R, E2, R2>(
  tool: string,
  plan: (
    params: P,
    /** `asked`: the person is asked before `run`, so what a full-access call skips is read. */
    caller: { readonly asked: boolean },
  ) => Effect.Effect<
    {
      readonly asks: OutsideAction;
      readonly run: Effect.Effect<A, E, R>;
    },
    E2,
    R2
  >,
) =>
  declare(
    (params: P) =>
      Effect.gen(function* () {
        const caller = yield* writingCaller;
        yield* assertNotLinked(caller, startsOutsideWork);
        const asked = !hasFullAccess(caller);
        const planned = yield* plan(params, { asked });
        const approved = yield* personApproves(caller, tool, params, planned.asks);
        if (approved === undefined) return yield* planned.run;
        // The person takes as long as they like to answer, and a client may bring the answer
        // in the call that asked. So what runs is read now, after the answer, and only if it
        // is still what they were asked about.
        const now = yield* plan(params, { asked });
        if (requestOf(tool, params, now.asks) !== approved.request) {
          return yield* outsideActionRefused(
            `Not done: what "${approved.sentence}" would do changed while the user was asked. Call again to ask.`,
          );
        }
        return yield* now.run;
      }),
    () =>
      Effect.gen(function* () {
        const caller = yield* writingCaller;
        if (!hasFullAccess(caller)) return yield* outsideActionRefused(LINKED_NEEDS_FULL_ACCESS);
      }),
  );

export const writesThreads = <P, A, E, R>(
  threads: (params: P) => ReadonlyArray<ThreadId | undefined>,
  handle: (params: P) => Effect.Effect<A, E, R>,
) =>
  declare(
    (params: P) =>
      Effect.gen(function* () {
        const caller = yield* writingCaller;
        for (const threadId of threads(params)) {
          if (threadId === undefined || threadId === caller.scope.thread?.threadId) continue;
          const target = yield* caller.threads
            .getThreadShell(threadId)
            .pipe(Effect.mapError(unavailable));
          if (target !== null && target.deletedAt === null) {
            yield* assertTargetWithinLimits(caller.limits, target);
            yield* assertSameLink(caller, target);
          }
        }
        // Modes can rise after this check; the orchestrator rechecks under lock and records refusal before handlers wrap errors.
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
    () => writingCaller,
  );

const escalationDenied = (refusal: DispatchModeRefusal) =>
  new OrchestratorMcpFailure({
    code:
      refusal.mode === "runtime"
        ? "runtime_mode_escalation_denied"
        : "interaction_mode_escalation_denied",
    message: `Thread ${refusal.threadId} now runs in ${refusal.runtimeMode}/${refusal.interactionMode} mode, above this caller's. Its user changed it while this call ran.`,
  });

export interface StartedModes {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  /** The linked environment the caller acts for. The thread must carry it. */
  readonly linkOrigin: OrchestrationV2LinkOrigin | undefined;
}

/**
 * Starts threads with the modes `modes` requests, which may not be broader
 * than the caller's. `linked` says what a linked caller gets: threads stamped
 * with its `linkOrigin`, or a refusal where the tool cannot carry one.
 */
export const startsThreads = <P, A, E, R>(
  modes: (params: P) => {
    readonly runtimeMode?: RuntimeMode | undefined;
    readonly interactionMode?: ProviderInteractionMode | undefined;
  },
  handle: (params: P, modes: StartedModes) => Effect.Effect<A, E, R>,
  linked: "stamped" | { readonly refused: string },
) => {
  const started = Effect.fn("McpToolAccess.started")(function* (caller: Caller, params: P) {
    const requested = modes(params);
    return {
      runtimeMode: yield* resolveRuntimeMode(caller.limits.runtimeMode, requested.runtimeMode),
      interactionMode: yield* resolveInteractionMode(
        caller.limits.interactionMode,
        requested.interactionMode,
      ),
      linkOrigin: callerLinkOrigin(caller),
    } satisfies StartedModes;
  });
  return declare(
    (params: P) =>
      Effect.gen(function* () {
        const caller = yield* writingCaller;
        if (linked !== "stamped") yield* assertNotLinked(caller, linked.refused);
        return yield* handle(params, yield* started(caller, params));
      }),
    (params: P) => Effect.flatMap(writingCaller, (caller) => started(caller, params)),
  );
};

/** One tool with two access rules, picked per call, such as create versus update. */
export const either = <P, A, E, R, A2, E2, R2>(
  useFirst: (params: P) => boolean,
  first: Declaration<(params: P) => Effect.Effect<A, E, R>>,
  second: Declaration<(params: P) => Effect.Effect<A2, E2, R2>>,
) => {
  const remotes = [remoteCheckOf(first), remoteCheckOf(second)] as ReadonlyArray<
    RemoteCheck<P> | undefined
  >;
  return declare(
    (params: P): Effect.Effect<A | A2, E | E2, R | R2> =>
      useFirst(params) ? checkedHandler(first)(params) : checkedHandler(second)(params),
    (params) =>
      remotes[useFirst(params) ? 0 : 1]?.(params) ??
      Effect.fail(
        new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "This action acts as the calling thread, which is here. Omit environmentId.",
        }),
      ),
  );
};

/**
 * `declaration`, whose result from a linked environment then goes through
 * `forwarded` here, for what this environment records about the call.
 */
export const afterForwarding = <P, A, E, R, E2, R2>(
  declaration: Declaration<(params: P) => Effect.Effect<A, E, R>>,
  forwarded: Forwarded<P, A, E2, R2>,
) =>
  declare(
    checkedHandler(declaration) as (params: P) => Effect.Effect<A, E | E2, R | R2>,
    remoteCheckOf(declaration) as RemoteCheck<P> | undefined,
    forwarded,
  );

const fullAccessRequired =
  "Changing projects or environment settings needs a live full-access/default calling thread or a full-access client.";
const changesEnvironment = "change projects or environment settings";

/** Recheck after waits before writing; caller modes may have changed. */
export const writesEnvironment = <P, A, E, R>(
  handle: (
    params: P,
    check: Effect.Effect<Caller, OrchestratorMcpFailure, CheckServices>,
  ) => Effect.Effect<A, E, R>,
  options?: {
    /**
     * Whether a linked caller may make it, as for adding a project: it leaves
     * everything already here as it was.
     */
    readonly linkedCallers?: "allowed";
  },
) => {
  const check = orchestratingCaller.pipe(
    Effect.tap((caller) =>
      options?.linkedCallers === "allowed"
        ? Effect.void
        : assertNotLinked(caller, changesEnvironment),
    ),
    Effect.tap((caller) =>
      assertFullAccessNamingLink(caller, fullAccessRequired, changesEnvironment),
    ),
  );
  return declare(
    (params: P) => check.pipe(Effect.flatMap(() => handle(params, check))),
    // Linked work never reaches a link at all; that is checked as the call goes.
    () =>
      orchestratingCaller.pipe(
        Effect.tap((caller) => assertFullAccess(caller, fullAccessRequired)),
      ),
  );
};

type CheckServices = Effect.Services<typeof orchestratingCaller>;

type Declarations<Handlers> = {
  readonly [Name in keyof Handlers]: Declaration<Handlers[Name]> & NotCallable;
};

type NotCallable = { readonly call?: never } & { readonly apply?: never };

export type Handlers<Tools extends Record<string, Tool.Any>> = Declarations<
  Toolkit.HandlersFrom<Tools>
>;

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
  static layer<Tools extends Record<string, Tool.Any>, EX, RX>(
    handlers: HandlersLayer<Tools, EX, RX>,
  ) {
    return handlers.#layer;
  }
}

const checkedHandlers = <Handlers>(declarations: Declarations<Handlers>): Handlers =>
  Struct.map(declarations, checkedHandler);

/**
 * A tool runs in a linked environment when its parameters take this target
 * as `environmentId`. Other tools may name an environment for their own
 * reasons, such as the one to link or to move a thread to.
 */
const takesLinkedEnvironment = (tool: Tool.Any) => {
  const parameters: unknown = tool.parametersSchema;
  return (
    Predicate.hasProperty(parameters, "fields") &&
    Predicate.hasProperty(parameters.fields, "environmentId") &&
    parameters.fields.environmentId === OrchestratorMcpEnvironmentTarget
  );
};

const linksUnavailable = new OrchestratorMcpFailure({
  code: "orchestration_error",
  message: "This environment cannot reach linked environments.",
});

const THREAD_ONLY = new Set<unknown>([
  McpInvocationContext.hiddenFromOutsideClients,
  McpInvocationContext.hiddenWithoutBackgroundWait,
]);

/**
 * Every tool that takes a linked environment runs there the same way: its
 * declaration checks the caller here, and the same call goes to the other
 * environment, which checks the rest. The handler here never sees
 * `environmentId`, so it cannot leak into what it writes.
 */
const routed = Effect.fn("McpToolAccess.routed")(function* <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
  declarations: Handlers<Tools>,
  checked: Toolkit.HandlersFrom<Tools>,
) {
  // Optional so toolkits that never leave this environment build without it.
  const forwarding = yield* Effect.serviceOption(PeerForwarding.PeerForwarding);
  const handlers: Record<string, unknown> = { ...checked };
  for (const [name, declaration] of Object.entries<Declaration<unknown>>(declarations)) {
    const tool = toolkit.tools[name];
    if (tool === undefined) continue;
    const remote = remoteCheckOf(declaration);
    if (
      remote === undefined &&
      !THREAD_ONLY.has(Context.getOrUndefined(tool.annotations, McpSchema.EnabledWhen))
    )
      return yield* Effect.die(
        `${name} acts as its calling thread, so outside clients must not be offered it.`,
      );
    if (!takesLinkedEnvironment(tool)) continue;
    const forwarded = forwardedOf(declaration) as
      | Forwarded<object, unknown, Tool.Failure<Tools[keyof Tools]>, never>
      | undefined;
    if (remote === undefined)
      return yield* Effect.die(
        `${name} takes a linked environment, but it acts as its calling thread, which is here.`,
      );
    const here = handlers[name] as (
      params: object,
    ) => Effect.Effect<unknown, Tool.Failure<Tools[keyof Tools]>>;
    handlers[name] = ({ environmentId, ...params }: { readonly environmentId?: EnvironmentId }) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const target = PeerForwarding.remoteTarget(scope, environmentId);
        if (target === undefined) return yield* here(params);
        if (scope.linkedEnvironments === false) return yield* PeerForwarding.linkedEnvironmentsOff;
        yield* (remote as RemoteCheck<typeof params>)(params);
        if (Option.isNone(forwarding)) return yield* linksUnavailable;
        const result = yield* forwarding.value.call(scope, tool, target, {
          ...params,
          environmentId,
        });
        return forwarded === undefined ? result : yield* forwarded(params, target, result);
      });
  }
  return handlers as Toolkit.HandlersFrom<Tools>;
});

export const toLayer = <Tools extends Record<string, Tool.Any>, EX = never, RX = never>(
  toolkit: Toolkit.Toolkit<Tools>,
  build: Handlers<Tools> | Effect.Effect<Handlers<Tools>, EX, RX>,
): HandlersLayer<Tools, EX, Exclude<RX, Scope.Scope>> => {
  // Checked as soon as they are given, so a forged declaration fails here.
  const withDeclarations = (declarations: Handlers<Tools>) =>
    routed(toolkit, declarations, checkedHandlers(declarations));
  return handlersLayer(
    toolkit.toLayer(
      Effect.isEffect(build) ? Effect.flatMap(build, withDeclarations) : withDeclarations(build),
    ),
  );
};
