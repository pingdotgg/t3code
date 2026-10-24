import { AgentFileSyncError, EnvironmentId, type AgentFileSyncLink } from "@t3tools/contracts";
import * as Layer from "effect/Layer";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it } from "vite-plus/test";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { createAgentFileSyncAtoms, startAgentFileSyncRelay } from "./agentFileSync.ts";

it.each([
  { allowed: false, sourceFailure: false },
  { allowed: true, sourceFailure: false },
  { allowed: true, sourceFailure: true },
])(
  "relays with permission=$allowed and source failure=$sourceFailure",
  async ({ allowed, sourceFailure }) => {
    const source = EnvironmentId.make("source");
    const destination = EnvironmentId.make("destination");
    const last = EnvironmentId.make("last");
    const registry = AtomRegistry.make();
    using _registry = { [Symbol.dispose]: () => registry.dispose() };
    const runtime = Atom.runtime(
      Layer.succeed(EnvironmentRegistry, {} as EnvironmentRegistry["Service"]),
    );
    const base = createAgentFileSyncAtoms(runtime);
    const link: AgentFileSyncLink = {
      id: "c47cb967-60e2-4f6e-88a4-8aeb767d3706",
      scope: {},
      sourceEnvironmentId: source,
      selection: { skills: [], instructions: [{ path: "AGENTS.md", sectionIds: ["Shared:0"] }] },
      label: "Source",
      paused: false,
      error: null,
      generation: 7,
      revision: "revision",
      lastSyncedAt: 0,
    };
    const permissionAtom = Atom.family((id: EnvironmentId | null) =>
      Atom.make(id === last || (id === destination && allowed)),
    );
    const requested: EnvironmentId[] = [];
    let checks = 0;
    let refreshes = 0;
    const pauses: unknown[] = [];
    const finished = Promise.withResolvers<void>();
    const atoms: typeof base = {
      ...base,
      links: ({ environmentId }) => {
        requested.push(environmentId);
        if (environmentId === last) finished.resolve();
        return Atom.make(AsyncResult.success(environmentId === destination ? [link] : []));
      },
      check: () => {
        checks++;
        return Atom.make(
          sourceFailure
            ? AsyncResult.fail(new AgentFileSyncError({ reason: "changed" }))
            : AsyncResult.success({ bundle: null }),
        );
      },
      manage: {
        ...base.manage,
        run: async (_registry, request) => {
          pauses.push(request.input);
          return AsyncResult.success(undefined);
        },
      },
      refresh: {
        ...base.refresh,
        permissionAtom,
        run: async () => {
          refreshes++;
          return AsyncResult.success(undefined);
        },
      },
    };
    using _relay = {
      [Symbol.dispose]: startAgentFileSyncRelay(registry, atoms, [destination, source, last]),
    };
    await finished.promise;
    expect(requested).toEqual(allowed ? [destination, last] : [last]);
    expect(checks).toBe(allowed ? 1 : 0);
    expect(refreshes).toBe(allowed && !sourceFailure ? 1 : 0);
    expect(pauses).toEqual(
      sourceFailure
        ? [
            {
              id: link.id,
              generation: 7,
              action: "pause",
              error: new AgentFileSyncError({ reason: "changed" }).message,
            },
          ]
        : [],
    );
  },
);
