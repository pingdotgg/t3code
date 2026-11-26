import {
  type EnvironmentId,
  isRuntimeModeAbove,
  type OrchestrationV2LinkOrigin,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  ProviderApprovalPushHooks,
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
import * as Schema from "effect/Schema";
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
  viaLink?: ViaLink<P>,
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

/** One call on its way to a linked environment. */
interface LinkedCall<A, E, R> {
  readonly environmentId: EnvironmentId;
  /** The name the user gave the linked environment. */
  readonly label: string;
  /** Sends the call there, as it is or as one step of asking about it. */
  readonly send: (outsideAction?: LinkedOutsideAction) => Effect.Effect<A, E, R>;
}

/** Replaces the plain sending of a call to a linked environment, for a tool that asks first. */
type ViaLink<P> = <A, E, R>(
  params: P,
  link: LinkedCall<A, E, R>,
) => Effect.Effect<A, E | OrchestratorMcpFailure, R | Effect.Services<typeof writingCaller>>;
let viaLinkOf: <Handler>(declaration: Declaration<Handler>) => ViaLink<never> | undefined;

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
  readonly #viaLink: ViaLink<never> | undefined;
  private constructor(
    token: typeof builtHere,
    handle: Handler,
    remote: RemoteCheck<never> | undefined,
    forwarded: Forwarded<never, unknown, unknown, unknown> | undefined,
    viaLink: ViaLink<never> | undefined,
  ) {
    refuseOutsideConstruction(token);
    this.#handle = handle;
    this.#remote = remote;
    this.#forwarded = forwarded;
    this.#viaLink = viaLink;
  }
  static {
    declare = (handle, remote, forwarded, viaLink) =>
      new Declaration(
        builtHere,
        handle,
        remote,
        forwarded as Forwarded<never, unknown, unknown, unknown> | undefined,
        viaLink as ViaLink<never> | undefined,
      );
    viaLinkOf = (declaration) => declaration.#viaLink;
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
// unassigned and private-use code points, lone surrogates, every space but U+0020, and the
// marks Unicode says to draw as nothing, such as the combining grapheme joiner.
const UNSEEN =
  /[\p{C}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufffc]/gu;

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

/** Whether `quoted` shows all of `value`, for a name a person must see whole to approve. */
export const quotedWhole = (value: string, max = 120) =>
  quoted(value, max) === quoted(value, Number.POSITIVE_INFINITY);

const SHOWN_SENTENCE = {
  action: 600,
  target: 600,
  repository: 200,
  host: 200,
  origin: 200,
} as const;

/**
 * Whether the question names in full what the call would do. Its sentence is the server's own
 * words with names set into them, so one too long to show has left some of it out.
 */
const shownWhole = (asks: OutsideAction) =>
  (Object.keys(SHOWN_SENTENCE) as ReadonlyArray<keyof typeof SHOWN_SENTENCE>).every((part) => {
    const text = asks[part];
    return text === undefined || visible(text, SHOWN_SENTENCE[part]) === visible(text, Infinity);
  });

/** The last check on every word a person is shown, whatever the handler put in it. */
const shownAction = (asks: OutsideAction): OutsideAction => ({
  ...asks,
  action: visible(asks.action, SHOWN_SENTENCE.action),
  target: visible(asks.target, SHOWN_SENTENCE.target),
  ...(asks.repository === undefined
    ? {}
    : { repository: visible(asks.repository, SHOWN_SENTENCE.repository) }),
  ...(asks.host === undefined ? {} : { host: visible(asks.host, SHOWN_SENTENCE.host) }),
  ...(asks.origin === undefined ? {} : { origin: visible(asks.origin, SHOWN_SENTENCE.origin) }),
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
 * Asks the person behind the calling thread to approve `asks`, and ends unless they did. They
 * are asked in the thread, by a request the server raises and whose answer it records itself;
 * `request` names what the answer is for, and an answer counts for that alone.
 */
const askInThread = Effect.fnUntraced(function* (
  caller: Caller,
  tool: string,
  request: string,
  asks: OutsideAction,
) {
  const sentence = outsideActionSentence(asks);
  const { also: _also, binds: _binds, pushHooks, ...named } = asks;
  const answer = yield* McpThreadApproval.ask(caller, {
    state: `${tool} ${request}`,
    // The start of the request's own name ends the question, so two requests never read alike.
    message: `${sentence}? (request ${hashToolInput({ request }).slice(0, 8)})`,
    toolAction: { tool, ...named },
    pushHooks,
  });
  switch (answer) {
    case "accepted":
      return sentence;
    case "declined":
      return yield* outsideActionRefused(`Not done: the user declined "${sentence}".`);
    case "cancelled":
      return yield* outsideActionRefused(
        `Cancelled, nothing was done: the request to approve "${sentence}" ended without the user's answer. They dismissed it, or the turn ended or was interrupted. Ask the user before trying again.`,
      );
    case "unavailable":
      return yield* outsideActionRefused(
        `Not done: "${sentence}" needs the user's approval below Full access, and this agent's client cannot ask for it. Tell the user; they can do it themselves or switch this thread to Full access.`,
      );
    case "no-turn":
      return yield* outsideActionRefused(
        `Not done: "${sentence}" needs the user's approval below Full access, and T3 Code asks them in a turn of this thread, which has none running now. Call again during a turn.`,
      );
  }
});

/**
 * How a call made for a linked environment's thread is asked about. That environment has the
 * person; this one has the checkout and the forge login, so only it can say what the call
 * would do. "describe" has it say so and do nothing; `approved` names the request the person
 * then approved there.
 */
export type LinkedOutsideAction = "describe" | { readonly approved: string };

/** What "describe" answers with: the request and the words the other environment shows. */
const LinkedDescription = Schema.Struct({
  request: Schema.String,
  asks: Schema.Struct({
    action: Schema.String,
    target: Schema.String,
    repository: Schema.optional(Schema.String),
    host: Schema.optional(Schema.String),
    origin: Schema.optional(Schema.String),
    also: Schema.optional(Schema.String),
    pushHooks: Schema.optional(ProviderApprovalPushHooks),
  }),
});
const LinkedDescriptionJson = Schema.fromJsonString(LinkedDescription);
const encodeLinkedDescription = Schema.encodeSync(LinkedDescriptionJson);
const decodeLinkedDescription = Schema.decodeUnknownOption(LinkedDescriptionJson);

/** Starts the refusal that carries a description back. Never shown: the asking side reads it. */
const LINKED_DESCRIPTION = "t3-outside-action-description ";

/**
 * Below Full access, ends unless the person approved exactly this: the tool, its arguments and
 * what they resolved to; then returns the request they approved. Anything that differs on a
 * later call is another request, and asks again.
 */
const personApproves = Effect.fnUntraced(function* (
  caller: Caller,
  tool: string,
  params: unknown,
  resolved: OutsideAction,
) {
  // A linked environment calls for a thread of its own, and asks the person there.
  const linked = caller.scope.client?.linked === true ? caller.scope.outsideAction : undefined;
  // Asked to describe, it only describes, whatever the caller's access.
  if (linked !== "describe" && hasFullAccess(caller)) return;
  if (!shownWhole(resolved)) {
    return yield* outsideActionRefused(
      "Not done: what this call would do is too long to show the user in full, so they cannot be asked to approve it. Tell the user; they can do it themselves or switch this thread to Full access.",
    );
  }
  const asks = shownAction(resolved);
  const sentence = outsideActionSentence(asks);
  const request = requestOf(tool, params, resolved);
  if (caller.caller !== undefined) {
    yield* askInThread(caller, tool, request, asks);
    return { request, sentence };
  }
  if (linked === "describe") {
    const { binds: _binds, ...shown } = asks;
    return yield* outsideActionRefused(
      `${LINKED_DESCRIPTION}${encodeLinkedDescription({ request, asks: shown })}`,
    );
  }
  if (linked !== undefined) {
    if (linked.approved === request) return { request, sentence };
    return yield* outsideActionRefused(
      `Not done: what "${sentence}" would do changed while the user was asked. Call again to ask.`,
    );
  }
  return yield* outsideActionRefused(
    `Not done: "${sentence}" needs full access for this MCP client, which has no thread where a person could approve it.`,
  );
});

interface Planned<A, E, R, Asks> {
  readonly asks: Asks;
  readonly run: Effect.Effect<A, E, R>;
}

/**
 * Runs what `plan` resolved once the person approved what it asks. They take as long as they
 * like to answer, so what runs is read again after the answer, and only if it is still what
 * they were asked about.
 */
const runApproved = Effect.fnUntraced(function* <A, E, R, E2, R2>(
  caller: Caller,
  tool: string,
  params: unknown,
  // Called for each reading, so one a handler builds eagerly is still read twice.
  plan: () => Effect.Effect<Planned<A, E, R, OutsideAction | undefined>, E2, R2>,
) {
  const planned = yield* plan();
  if (planned.asks === undefined) return yield* planned.run;
  const approved = yield* personApproves(caller, tool, params, planned.asks);
  if (approved === undefined) return yield* planned.run;
  const now = yield* plan();
  if (now.asks === undefined || requestOf(tool, params, now.asks) !== approved.request) {
    return yield* outsideActionRefused(
      `Not done: what "${approved.sentence}" would do changed while the user was asked. Call again to ask.`,
    );
  }
  return yield* now.run;
});

const startsOutsideWork = "start work here that is not its link's";

const isMcpFailure = Schema.is(OrchestratorMcpFailure);

const LINKED_DID_NOT_DESCRIBE =
  "Stopped: below Full access the user approves this action first, and the linked environment answered without saying what it would do. Tell the user, and do not call again.";

/**
 * A call bound for a linked environment. Below Full access that environment first says what
 * the call would do and does nothing; the person is asked about that here; and the call goes
 * again naming the request they approved, which is carried out only if it still resolves to it.
 */
const askedViaLink = Effect.fnUntraced(function* <A, E, R>(
  tool: string,
  params: unknown,
  link: LinkedCall<A, E, R>,
) {
  const caller = yield* writingCaller;
  if (hasFullAccess(caller)) return yield* link.send();
  const refusal = yield* Effect.flip(link.send("describe")).pipe(
    // Only an environment that says it describes is sent this, so it never acts on it.
    Effect.orElseSucceed(() => outsideActionRefused(LINKED_DID_NOT_DESCRIBE)),
  );
  const described =
    isMcpFailure(refusal) && refusal.message.startsWith(LINKED_DESCRIPTION)
      ? Option.getOrUndefined(
          decodeLinkedDescription(refusal.message.slice(LINKED_DESCRIPTION.length)),
        )
      : undefined;
  // Any other refusal is that environment's own, and is the answer.
  if (described === undefined) return yield* Effect.fail(refusal as E | OrchestratorMcpFailure);
  const there = shownAction(described.asks);
  yield* askInThread(
    caller,
    tool,
    hashToolInput({ params, environmentId: link.environmentId, request: described.request }),
    { ...there, target: `${there.target} (in linked environment ${quoted(link.label)})` },
  );
  return yield* link.send({ approved: described.request });
});

/**
 * Acts outside the thread with the user's own access, as a forge write does. Below Full access
 * the person approves first. `plan` checks the arguments and resolves all the action depends
 * on into `asks`; `run` acts on that and compares anything it must read again, doing nothing
 * when it differs. A call that turns out to do nothing outside asks nothing.
 */
export const actsOutsideThread = <P, A, E, R, E2, R2>(
  tool: string,
  plan: (
    params: P,
    /** `asked`: the person is asked before `run`, so what a full-access call skips is read. */
    caller: { readonly asked: boolean },
  ) => Effect.Effect<Planned<A, E, R, OutsideAction | undefined>, E2, R2>,
) =>
  declare(
    (params: P) =>
      Effect.gen(function* () {
        const caller = yield* writingCaller;
        yield* assertNotLinked(caller, startsOutsideWork);
        const asked = !hasFullAccess(caller);
        return yield* runApproved(caller, tool, params, () => plan(params, { asked }));
      }),
    () => writingCaller,
    undefined,
    (params, link) => askedViaLink(tool, params, link),
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
        const { call, label } = forwarding.value;
        const send = (outsideAction?: LinkedOutsideAction) =>
          call(scope, tool, target, { ...params, environmentId }, outsideAction);
        const viaLink = viaLinkOf(declaration) as ViaLink<typeof params> | undefined;
        const result =
          viaLink === undefined
            ? yield* send()
            : yield* viaLink(params, {
                environmentId: target,
                label: yield* label(target),
                send,
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
