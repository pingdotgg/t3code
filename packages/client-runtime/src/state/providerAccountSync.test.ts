import { describe, expect, it } from "@effect/vitest";
import {
  AuthProvidersManageScope,
  EnvironmentId,
  ProviderAccountTransferError,
  ProviderDriverKind,
  ProviderInstanceId,
  type AuthSessionState,
  type ProviderAccountExport,
  type ProviderAccountImportResult,
  WS_METHODS,
} from "@t3tools/contracts";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";

import { AVAILABLE_CONNECTION_STATE } from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  type AccountSyncEnvironment,
  createProviderAccountSyncCommand,
  planProviderAccountSync,
  type ProviderAccountSyncRequest,
  supportsProviderAccountSync,
  syncedAccountState,
} from "./providerAccountSync.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState>>(AsyncResult.initial()),
);

const laptop = EnvironmentId.make("laptop");
const studio = EnvironmentId.make("studio");
const server = EnvironmentId.make("server");
const codex = ProviderDriverKind.make("codex");
const cursor = ProviderDriverKind.make("cursor");
const workCodex = ProviderInstanceId.make("codex_work");
const defaultCursor = ProviderInstanceId.make("cursor");

const grant = (allowed: boolean): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: allowed ? [AuthProvidersManageScope] : [],
  permissions: allowed ? [AuthProvidersManageScope] : [],
});

const exportOf = (instanceId: ProviderInstanceId): ProviderAccountExport => ({
  instanceId,
  instance: { driver: codex, config: {}, environment: [] },
  secrets: [{ _tag: "EnvironmentVariable", name: "OPENAI_API_KEY", value: "sk-secret" }],
  omitted: [],
});

interface FakeEnvironment {
  readonly connected?: boolean;
  readonly capability?: boolean;
  readonly exportAccount?: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderAccountExport, ProviderAccountTransferError>;
  readonly importAccount?: (
    account: ProviderAccountExport,
  ) => Effect.Effect<ProviderAccountImportResult, ProviderAccountTransferError>;
}

const makeHarness = Effect.fn("makeProviderAccountSyncHarness")(function* (
  environments: Readonly<Record<string, FakeEnvironment>>,
) {
  const calls: Array<string> = [];
  const tracerEnabledDuringTransfer: Array<boolean> = [];
  const supervisors = new Map<
    EnvironmentId,
    EnvironmentSupervisor.EnvironmentSupervisor["Service"]
  >();
  for (const [id, environment] of Object.entries(environments)) {
    const environmentId = EnvironmentId.make(id);
    const client = {
      [WS_METHODS.providerAccountExport]: ({ instanceId }: { instanceId: ProviderInstanceId }) =>
        Effect.gen(function* () {
          calls.push(`export:${id}:${instanceId}`);
          tracerEnabledDuringTransfer.push(yield* References.TracerEnabled);
          return yield* (
            environment.exportAccount ?? ((target) => Effect.succeed(exportOf(target)))
          )(instanceId);
        }),
      [WS_METHODS.providerAccountImport]: ({ account }: { account: ProviderAccountExport }) =>
        Effect.gen(function* () {
          calls.push(`import:${id}:${account.instanceId}`);
          tracerEnabledDuringTransfer.push(yield* References.TracerEnabled);
          return yield* (
            environment.importAccount ??
            ((incoming) =>
              Effect.succeed({
                instanceId: incoming.instanceId,
                change: "created" as const,
                omitted: incoming.omitted,
              }))
          )(account);
        }),
    };
    supervisors.set(
      environmentId,
      EnvironmentSupervisor.EnvironmentSupervisor.of({
        // @effect-diagnostics-next-line schemaClassObjectLiteral:off -- The sync command reads only the environment identity from this supervisor fixture.
        target: { environmentId },
        session: yield* SubscriptionRef.make(
          environment.connected === false
            ? Option.none()
            : Option.some({
                client,
                initialConfig: Effect.succeed({
                  environment: {
                    capabilities: { providerAccountTransfer: environment.capability ?? true },
                  },
                }),
              } as unknown as RpcSession),
        ),
        state: yield* SubscriptionRef.make({
          ...AVAILABLE_CONNECTION_STATE,
          phase: "connected" as const,
        }),
      } as EnvironmentSupervisor.EnvironmentSupervisor["Service"]),
    );
  }
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
      run: (environmentId, effect) => {
        const supervisor = supervisors.get(environmentId);
        return supervisor === undefined
          ? Effect.die(`unknown environment ${environmentId}`)
          : Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
      },
    } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
  );
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  for (const environmentId of supervisors.keys()) {
    registry.set(sessions(environmentId), AsyncResult.success(grant(true)));
  }
  const command = createProviderAccountSyncCommand(runtime);
  const sync = (request: ProviderAccountSyncRequest) =>
    Effect.promise(() => command.run(registry, request)).pipe(
      Effect.map((result) => {
        if (!AsyncResult.isSuccess(result)) throw new Error("sync must settle every cell");
        return result.value.cells.map((cell) => {
          const key = `${cell.instanceId}->${cell.destinationEnvironmentId}`;
          switch (cell.status) {
            case "synced":
              return `${key} synced ${cell.change}`;
            case "skipped":
              return `${key} skipped ${cell.end} ${cell.reason}`;
            case "failed":
              return `${key} failed ${cell.stage} ${cell.message}`;
          }
        });
      }),
    );
  return { calls, command, registry, sync, tracerEnabledDuringTransfer };
});

const request = (
  instanceIds: ReadonlyArray<ProviderInstanceId>,
  destinationEnvironmentIds: ReadonlyArray<EnvironmentId>,
): ProviderAccountSyncRequest => ({
  sourceEnvironmentId: laptop,
  instanceIds,
  destinationEnvironmentIds,
});

describe("providerAccountSync command", () => {
  it.effect("exports each account once and imports that snapshot into every destination", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness({ [laptop]: {}, [studio]: {}, [server]: {} });
        expect(yield* h.sync(request([workCodex, defaultCursor], [studio, server]))).toEqual([
          `${workCodex}->${studio} synced created`,
          `${workCodex}->${server} synced created`,
          `${defaultCursor}->${studio} synced created`,
          `${defaultCursor}->${server} synced created`,
        ]);
        expect(h.calls.filter((call) => call.startsWith("export:")).sort()).toEqual([
          `export:${laptop}:${workCodex}`,
          `export:${laptop}:${defaultCursor}`,
        ]);
        expect(h.calls.filter((call) => call.startsWith("import:"))).toHaveLength(4);
      }),
    ),
  );

  it.effect("runs the transfer calls with tracing off so a payload never reaches a span", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness({ [laptop]: {}, [studio]: {} });
        yield* h.sync(request([workCodex], [studio]));
        expect(h.tracerEnabledDuringTransfer).toEqual([false, false]);
      }),
    ),
  );

  it.effect("coalesces an identical double submit but runs a different request on its own", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness({ [laptop]: {}, [studio]: {}, [server]: {} });
        const [codexReport, cursorReport, repeated] = yield* Effect.all(
          [
            h.sync(request([workCodex], [studio])),
            h.sync(request([defaultCursor], [studio])),
            h.sync(request([workCodex], [studio])),
          ],
          { concurrency: "unbounded" },
        );
        expect(codexReport).toEqual([`${workCodex}->${studio} synced created`]);
        expect(cursorReport).toEqual([`${defaultCursor}->${studio} synced created`]);
        expect(repeated).toEqual(codexReport);
        expect(h.calls.filter((call) => call.startsWith("export:")).sort()).toEqual([
          `export:${laptop}:${workCodex}`,
          `export:${laptop}:${defaultCursor}`,
        ]);
      }),
    ),
  );

  it.effect("skips a destination that lacks the capability without calling it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness({
          [laptop]: {},
          [studio]: {},
          [server]: { capability: false },
        });
        expect(yield* h.sync(request([workCodex], [studio, server]))).toEqual([
          `${workCodex}->${studio} synced created`,
          `${workCodex}->${server} skipped destination update-required`,
        ]);
        expect(h.calls).not.toContain(`import:${server}:${workCodex}`);
      }),
    ),
  );

  it.effect("skips every cell from a source that is not connected, and exports nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness({ [laptop]: { connected: false }, [studio]: {} });
        expect(yield* h.sync(request([workCodex], [studio, laptop]))).toEqual([
          `${workCodex}->${studio} skipped source not-connected`,
          `${workCodex}->${laptop} skipped destination same-environment`,
        ]);
        expect(h.calls).toEqual([]);
      }),
    ),
  );

  it.effect("fails every open destination at the export stage when the source refuses", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness({
          [laptop]: {
            exportAccount: (instanceId) =>
              Effect.fail(
                new ProviderAccountTransferError({ instanceId, reason: "instance-not-found" }),
              ),
          },
          [studio]: {},
          [server]: {},
        });
        const message = "This account no longer exists on the source.";
        expect(yield* h.sync(request([workCodex], [studio, server]))).toEqual([
          `${workCodex}->${studio} failed export ${message}`,
          `${workCodex}->${server} failed export ${message}`,
        ]);
        expect(h.calls.filter((call) => call.startsWith("import:"))).toEqual([]);
      }),
    ),
  );

  it.effect("keeps the other destinations synced when one import fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness({
          [laptop]: {},
          [studio]: {
            importAccount: (account) =>
              Effect.fail(
                new ProviderAccountTransferError({
                  instanceId: account.instanceId,
                  reason: "instance-id-conflict",
                }),
              ),
          },
          [server]: {},
        });
        expect(yield* h.sync(request([workCodex], [studio, server]))).toEqual([
          `${workCodex}->${studio} failed import This environment already has a different provider with this account's ID.`,
          `${workCodex}->${server} synced created`,
        ]);
      }),
    ),
  );

  it.effect("turns a remote interrupt into a failed cell and finishes the other cells", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness({
          [laptop]: {
            exportAccount: (instanceId) =>
              instanceId === defaultCursor
                ? Effect.interrupt
                : Effect.succeed(exportOf(instanceId)),
          },
          [studio]: {
            importAccount: (account) =>
              Effect.succeed({
                instanceId: account.instanceId,
                change: "created" as const,
                omitted: [],
              }),
          },
          [server]: { importAccount: () => Effect.interrupt },
        });
        const interrupted = (end: string) =>
          `failed ${end} The connection to the ${end === "export" ? "source" : "destination"} device was interrupted. Sync again.`;
        expect(yield* h.sync(request([workCodex, defaultCursor], [studio, server]))).toEqual([
          `${workCodex}->${studio} synced created`,
          `${workCodex}->${server} ${interrupted("import")}`,
          `${defaultCursor}->${studio} ${interrupted("export")}`,
          `${defaultCursor}->${server} ${interrupted("export")}`,
        ]);
      }),
    ),
  );

  it.effect("stops the sync when the command itself is cancelled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const exportStarted = yield* Deferred.make<void>();
        const exportInterrupted = yield* Deferred.make<void>();
        const h = yield* makeHarness({
          [laptop]: {
            exportAccount: () =>
              Deferred.succeed(exportStarted, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() => Deferred.succeed(exportInterrupted, undefined)),
              ),
          },
          [studio]: {},
        });
        void h.command.run(h.registry, request([workCodex], [studio]));
        yield* Deferred.await(exportStarted);
        h.registry.dispose();
        yield* Deferred.await(exportInterrupted);
        yield* Effect.yieldNow;
        expect(h.calls).toEqual([`export:${laptop}:${workCodex}`]);
      }),
    ),
  );

  it.effect("reports a missing grant as skipped on the end that lacks it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness({ [laptop]: {}, [studio]: {}, [server]: {} });
        h.registry.set(sessions(studio), AsyncResult.success(grant(false)));
        expect(yield* h.sync(request([workCodex], [studio, server]))).toEqual([
          `${workCodex}->${studio} skipped destination permission-required`,
          `${workCodex}->${server} synced created`,
        ]);
        expect(h.calls).not.toContain(`import:${studio}:${workCodex}`);

        h.registry.set(sessions(laptop), AsyncResult.success(grant(false)));
        expect(yield* h.sync(request([workCodex], [server]))).toEqual([
          `${workCodex}->${server} skipped source permission-required`,
        ]);
        expect(h.calls.filter((call) => call.startsWith("export:"))).toHaveLength(1);
      }),
    ),
  );
});

const environment = (
  environmentId: EnvironmentId,
  overrides: Partial<AccountSyncEnvironment> = {},
): AccountSyncEnvironment => ({
  environmentId,
  label: environmentId,
  connection: { phase: "connected" },
  serverConfig: { environment: { capabilities: { providerAccountTransfer: true } } },
  canManageProviders: true,
  settings: { providerInstances: {} },
  providers: [],
  ...overrides,
});

describe("planProviderAccountSync", () => {
  const source = environment(laptop, {
    settings: { providerInstances: { [workCodex]: { driver: codex } } },
    providers: [
      { instanceId: workCodex, driver: codex, auth: { status: "unauthenticated" } },
      {
        instanceId: defaultCursor,
        driver: cursor,
        auth: { status: "authenticated", email: "me@example.test" },
      },
      { instanceId: ProviderInstanceId.make("codex"), driver: codex, auth: { status: "unknown" } },
    ],
  });

  it("offers configured and signed-in accounts, and blocks per environment", () => {
    const plan = planProviderAccountSync({
      source,
      destinations: [
        environment(laptop),
        environment(studio, { connection: { phase: "connecting" } }),
        environment(server, { serverConfig: null }),
        environment(EnvironmentId.make("locked"), { canManageProviders: false }),
      ],
      instanceIds: [workCodex],
    });
    expect(plan.sourceBlock).toBeNull();
    expect(plan.accounts.map((account) => [account.instanceId, account.signedInAs])).toEqual([
      [workCodex, undefined],
      [defaultCursor, "me@example.test"],
    ]);
    expect(plan.destinations.map((destination) => destination.block)).toEqual([
      "same-environment",
      "not-connected",
      "update-required",
      "permission-required",
    ]);
    expect(plan.cells.every((cell) => cell.action === "blocked")).toBe(true);
  });

  it("predicts create, update with the destination's sign-in, and id conflicts", () => {
    const plan = planProviderAccountSync({
      source,
      destinations: [
        environment(studio, {
          providers: [
            {
              instanceId: defaultCursor,
              driver: cursor,
              auth: { status: "authenticated", label: "Studio Cursor" },
            },
          ],
        }),
        environment(server, {
          settings: {
            providerInstances: { [workCodex]: { driver: ProviderDriverKind.make("antigravity") } },
          },
        }),
      ],
      instanceIds: [workCodex, defaultCursor],
    });
    expect(plan.cells).toEqual([
      { instanceId: workCodex, destinationEnvironmentId: studio, action: "create" },
      {
        instanceId: workCodex,
        destinationEnvironmentId: server,
        action: "blocked",
        reason: "instance-id-conflict",
      },
      {
        instanceId: defaultCursor,
        destinationEnvironmentId: studio,
        action: "update",
        signedInAs: "Studio Cursor",
      },
      { instanceId: defaultCursor, destinationEnvironmentId: server, action: "create" },
    ]);
  });

  it("blocks every cell when the source itself cannot export", () => {
    const plan = planProviderAccountSync({
      source: { ...source, canManageProviders: false },
      destinations: [environment(studio)],
      instanceIds: [workCodex],
    });
    expect(plan.sourceBlock).toBe("permission-required");
    expect(plan.cells).toEqual([
      {
        instanceId: workCodex,
        destinationEnvironmentId: studio,
        action: "blocked",
        reason: "permission-required",
      },
    ]);
  });
});

describe("syncedAccountState", () => {
  const live = { enabled: true, status: "ready" } as const;

  it("reads the destination's live snapshot", () => {
    expect(syncedAccountState(undefined)).toEqual({ kind: "starting" });
    expect(
      syncedAccountState({
        ...live,
        driver: codex,
        installed: true,
        auth: { status: "authenticated", email: "me@example.test" },
      }),
    ).toEqual({ kind: "ready", signedInAs: "me@example.test" });
    expect(
      syncedAccountState({
        ...live,
        driver: codex,
        installed: true,
        auth: { status: "unauthenticated" },
        setup: { canAuthenticate: true, canInstall: false },
      }),
    ).toEqual({ kind: "needs-sign-in" });
    expect(
      syncedAccountState({
        ...live,
        driver: ProviderDriverKind.make("grok"),
        installed: true,
        auth: { status: "unauthenticated" },
        setup: { canAuthenticate: false, canInstall: false, documentationUrl: "https://x.test" },
      }),
    ).toEqual({ kind: "needs-host-setup", documentationUrl: "https://x.test" });
  });

  it("says so when the destination's copy is turned off or erroring, whatever its sign-in", () => {
    const signedIn = {
      driver: codex,
      installed: true,
      auth: { status: "authenticated", email: "me@example.test" },
    } as const;
    expect(syncedAccountState({ ...signedIn, enabled: false, status: "disabled" })).toEqual({
      kind: "disabled",
    });
    expect(
      syncedAccountState({
        ...signedIn,
        enabled: true,
        status: "error",
        message: "Binary missing",
      }),
    ).toEqual({ kind: "error", message: "Binary missing" });
    expect(syncedAccountState({ ...signedIn, enabled: true, status: "error" })).toEqual({
      kind: "error",
      message: undefined,
    });
  });
});

describe("supportsProviderAccountSync", () => {
  it("needs a connected server that declares the capability", () => {
    expect(supportsProviderAccountSync(environment(laptop))).toBe(true);
    expect(
      supportsProviderAccountSync(environment(laptop, { connection: { phase: "connecting" } })),
    ).toBe(false);
    expect(
      supportsProviderAccountSync(
        environment(laptop, { serverConfig: { environment: { capabilities: {} } } }),
      ),
    ).toBe(false);
  });
});
