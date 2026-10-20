import {
  ProjectScriptPortUnavailableError,
  type ProjectScriptPortsInput,
} from "@t3tools/contracts";
import * as Net from "@t3tools/shared/Net";
import * as Context from "effect/Context";
import * as Hash from "effect/Hash";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

const FIRST_PORT = 20000;
const PORT_COUNT = 10000;

export class ProjectScriptPorts extends Context.Service<
  ProjectScriptPorts,
  {
    readonly reserve: (input: {
      readonly cwd: string;
      readonly scriptId: string;
    }) => Effect.Effect<number, ProjectScriptPortUnavailableError>;
    readonly get: (
      input: ProjectScriptPortsInput,
    ) => Effect.Effect<
      { readonly ports: Record<string, number> },
      ProjectScriptPortUnavailableError
    >;
  }
>()("t3/project/ProjectScriptPorts") {}

const make = Effect.gen(function* () {
  const net = yield* Net.NetService;
  const path = yield* Path.Path;
  const lock = yield* Semaphore.make(1);
  const assignments = new Map<string, number>();
  const assignedPorts = new Set<number>();

  // Keep assignments while the server lives: re-probing would move a port out from under
  // a running action. The OS probe cannot prevent another process binding after it closes.
  const reserve: ProjectScriptPorts["Service"]["reserve"] = Effect.fn("ProjectScriptPorts.reserve")(
    function* (input) {
      const key = `${path.resolve(input.cwd)}\0${input.scriptId}`;
      return yield* lock.withPermit(
        Effect.gen(function* () {
          const existing = assignments.get(key);
          if (existing !== undefined) return existing;
          const startPort = FIRST_PORT + (Math.abs(Hash.string(key)) % PORT_COUNT);
          for (let offset = 0; offset < PORT_COUNT; offset++) {
            const port = FIRST_PORT + ((startPort - FIRST_PORT + offset) % PORT_COUNT);
            if (assignedPorts.has(port) || !(yield* net.isPortAvailableOnLoopback(port))) continue;
            assignments.set(key, port);
            assignedPorts.add(port);
            yield* Effect.annotateCurrentSpan({ startPort, port, attempts: offset + 1 });
            return port;
          }
          return yield* new ProjectScriptPortUnavailableError({ startPort, attempts: PORT_COUNT });
        }),
      );
    },
  );

  return ProjectScriptPorts.of({
    reserve,
    get: Effect.fn("ProjectScriptPorts.get")(function* (input) {
      const entries = yield* Effect.forEach([...new Set(input.scriptIds)], (scriptId) =>
        reserve({ cwd: input.cwd, scriptId }).pipe(Effect.map((port) => [scriptId, port] as const)),
      );
      return { ports: Object.fromEntries(entries) };
    }),
  });
});

export const layer = Layer.effect(ProjectScriptPorts, make);
