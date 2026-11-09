import {
  NxtvironInstanceActionError,
  nxtvironInstanceActions,
  type NxtvironInstance,
  type NxtvironInstanceAction,
  type NxtvironInstanceActionInput,
  type NxtvironInstanceList,
  type NxtvironInstanceState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import * as ProcessRunner from "../processRunner.ts";

type Listener = (list: NxtvironInstanceList) => Effect.Effect<void>;

export class NxtvironInstances extends Context.Service<
  NxtvironInstances,
  {
    /** Calls `listener` with the current list, then on every change while the scope is open. */
    readonly subscribe: (listener: Listener) => Effect.Effect<void, never, Scope.Scope>;
    readonly act: (
      input: NxtvironInstanceActionInput,
    ) => Effect.Effect<void, NxtvironInstanceActionError>;
  }
>()("t3/preview/Nxtviron/NxtvironInstances") {}

const COMMAND = "nxtviron";
const POLL_INTERVAL = Duration.seconds(5);
const LIST_TIMEOUT = Duration.seconds(20);
const ACTION_TIMEOUT = Duration.minutes(2);
const UNAVAILABLE: NxtvironInstanceList = { available: false, instances: [] };

const RUNNING_STATUSES = new Set([
  "online",
  "launching",
  "running",
  "created",
  "restarting",
  "paused",
]);
const STOPPED_STATUSES = new Set(["stopped", "exited", "dead", "errored"]);

const instanceState = (status: string): NxtvironInstanceState => {
  if (RUNNING_STATUSES.has(status)) return "running";
  if (STOPPED_STATUSES.has(status)) return "stopped";
  if (status === "missing") return "missing";
  return "unavailable";
};

const CliInstance = Schema.Struct({
  process: Schema.String,
  id: Schema.String,
  ref: Schema.String,
  status: Schema.String,
  branch: Schema.optional(Schema.String),
  ports: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  proxy: Schema.optional(Schema.Struct({ hostname: Schema.String })),
  url: Schema.optional(Schema.String),
  configPath: Schema.String,
  workingDir: Schema.String,
});
type CliInstance = typeof CliInstance.Type;

const CliEnvelope = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), data: Schema.Unknown }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({ code: Schema.String, message: Schema.String }),
  }),
]);
const decodeEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(CliEnvelope));
const decodeInstances = Schema.decodeUnknownOption(
  Schema.Struct({ instances: Schema.Array(CliInstance) }),
);

const isPort = (port: number) => Number.isInteger(port) && port > 0 && port < 65536;

const toInstance = (raw: CliInstance): Option.Option<NxtvironInstance> => {
  const ref = raw.ref.trim();
  const process = raw.process.trim();
  const id = raw.id.trim();
  if (ref === "" || process === "" || id === "") return Option.none();
  const hostname = raw.proxy?.hostname.trim() ?? "";
  const url = raw.url?.trim() ?? "";
  return Option.some({
    ref,
    process,
    id,
    branch: raw.branch ?? null,
    status: raw.status,
    state: instanceState(raw.status),
    ports: Object.fromEntries(Object.entries(raw.ports ?? {}).filter(([, port]) => isPort(port))),
    proxyHostname: hostname === "" ? null : hostname,
    url: url === "" ? null : url,
    workingDir: raw.workingDir,
    configPath: raw.configPath,
  });
};

/** Parses `nxtviron --json instances` stdout; `None` when it is not a successful listing. */
export const parseInstanceList = (stdout: string): Option.Option<NxtvironInstanceList> =>
  decodeEnvelope(stdout).pipe(
    Option.flatMap((envelope) => (envelope.ok ? decodeInstances(envelope.data) : Option.none())),
    Option.map(({ instances }) => ({
      available: true,
      instances: instances.flatMap((raw) => Option.toArray(toInstance(raw))),
    })),
  );

const actionArgs = (
  instance: NxtvironInstance,
  action: NxtvironInstanceAction,
): ReadonlyArray<string> => {
  switch (action) {
    case "stop":
      return [
        "--json",
        "--config",
        instance.configPath,
        "stop",
        instance.process,
        "--instance",
        instance.id,
      ];
    case "resume":
      return [
        "--json",
        "--config",
        instance.configPath,
        "start",
        instance.process,
        "--instance",
        instance.id,
        "--action",
        "restart",
      ];
    case "delete":
      return ["--json", "delete", instance.ref];
  }
};

const decodeStopped = Schema.decodeUnknownOption(
  Schema.Struct({ stopped: Schema.Array(Schema.Unknown) }),
);

/** True when nxtviron ran in a scope that does not hold the instance; `stop` then stops nothing. */
const missedInstance = (
  action: NxtvironInstanceAction,
  envelope: typeof CliEnvelope.Type,
): boolean => {
  if (!envelope.ok) return envelope.error.code === "not_found" && action !== "delete";
  if (action !== "stop") return false;
  return Option.match(decodeStopped(envelope.data), {
    onNone: () => false,
    onSome: ({ stopped }) => stopped.length === 0,
  });
};

const actionError = (code: string, detail: string) =>
  new NxtvironInstanceActionError({ code, detail });

const listsEqual = (left: NxtvironInstanceList | null, right: NxtvironInstanceList) =>
  left !== null && JSON.stringify(left) === JSON.stringify(right);

interface State {
  readonly listeners: ReadonlySet<Listener>;
  readonly latest: NxtvironInstanceList | null;
}

const make = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const path = yield* Path.Path;
  const stateRef = yield* Ref.make<State>({ listeners: new Set(), latest: null });
  const refreshSemaphore = yield* Semaphore.make(1);

  const readList = processRunner
    .run({ command: COMMAND, args: ["--json", "instances"], timeout: LIST_TIMEOUT })
    .pipe(
      Effect.map((output) => parseInstanceList(output.stdout)),
      Effect.catchTags({ ProcessSpawnError: () => Effect.succeedSome(UNAVAILABLE) }),
      Effect.catchCause((cause) =>
        Effect.logWarning("nxtviron instance listing failed", Cause.pretty(cause)).pipe(
          Effect.as(Option.none<NxtvironInstanceList>()),
        ),
      ),
    );

  const refresh = Effect.fn("NxtvironInstances.refresh")(function* () {
    yield* refreshSemaphore.withPermits(1)(
      Effect.gen(function* () {
        if ((yield* Ref.get(stateRef)).latest?.available === false) return;
        const next = yield* readList;
        if (Option.isNone(next)) return;
        const listeners = yield* Ref.modify(stateRef, (state): [ReadonlySet<Listener>, State] =>
          listsEqual(state.latest, next.value)
            ? [new Set(), state]
            : [state.listeners, { ...state, latest: next.value }],
        );
        yield* Effect.forEach(listeners, (listener) => listener(next.value), { discard: true });
      }),
    );
  });

  // An unavailable CLI stays unavailable until the server restarts, like provider probing.
  const pollIfSubscribed = Ref.get(stateRef).pipe(
    Effect.flatMap((state) =>
      state.listeners.size > 0 && state.latest?.available !== false ? refresh() : Effect.void,
    ),
  );
  yield* Effect.forkScoped(pollIfSubscribed.pipe(Effect.repeat(Schedule.spaced(POLL_INTERVAL))));

  const subscribe: NxtvironInstances["Service"]["subscribe"] = Effect.fn(
    "NxtvironInstances.subscribe",
  )(function* (listener) {
    const latest = yield* Effect.acquireRelease(
      Ref.modify(stateRef, (state): [NxtvironInstanceList | null, State] => [
        state.latest,
        { ...state, listeners: new Set([...state.listeners, listener]) },
      ]),
      () =>
        Ref.update(stateRef, (state) => {
          const listeners = new Set(state.listeners);
          listeners.delete(listener);
          return { ...state, listeners };
        }),
    );
    if (latest === null) {
      yield* refresh();
    } else {
      yield* listener(latest);
    }
  });

  const listedInstances = Effect.gen(function* () {
    return (yield* Ref.get(stateRef)).latest?.instances ?? [];
  });

  const act: NxtvironInstances["Service"]["act"] = Effect.fn("NxtvironInstances.act")(
    function* (input) {
      let instance = (yield* listedInstances).find((candidate) => candidate.ref === input.ref);
      if (instance === undefined) {
        yield* refresh();
        instance = (yield* listedInstances).find((candidate) => candidate.ref === input.ref);
      }
      if (instance === undefined) {
        return yield* actionError("not_found", `No nxtviron instance ${input.ref} is listed.`);
      }
      if (!nxtvironInstanceActions(instance.state).includes(input.action)) {
        return yield* actionError(
          "invalid_state",
          `Can't ${input.action} ${instance.ref} while it is ${instance.status}.`,
        );
      }
      // `stop` and `start` rebuild the instance's scope from their cwd, which nxtviron does not
      // record. Without a process `workingDir` that cwd is the instance's own; with one, it is
      // usually the config's directory.
      const cwds = [...new Set([instance.workingDir, path.dirname(instance.configPath)])];
      for (const [index, cwd] of cwds.entries()) {
        const output = yield* processRunner
          .run({
            command: COMMAND,
            args: actionArgs(instance, input.action),
            cwd,
            timeout: ACTION_TIMEOUT,
          })
          .pipe(Effect.mapError((cause) => actionError("internal", cause.message)));
        const envelope = decodeEnvelope(output.stdout);
        if (Option.isNone(envelope)) {
          return yield* actionError(
            "internal",
            output.stderr.trim().split("\n").at(-1) || `nxtviron ${input.action} failed.`,
          );
        }
        const missed = missedInstance(input.action, envelope.value);
        if (missed && index < cwds.length - 1) continue;
        if (missed) {
          return yield* actionError(
            "not_found",
            `nxtviron could not find ${instance.ref} from its working directory.`,
          );
        }
        if (!envelope.value.ok) {
          return yield* actionError(envelope.value.error.code, envelope.value.error.message);
        }
        return;
      }
    },
    (effect) => Effect.ensuring(effect, refresh()),
  );

  return NxtvironInstances.of({ subscribe, act });
}).pipe(Effect.withSpan("NxtvironInstances.make"));

export const layer = Layer.effect(NxtvironInstances, make);
