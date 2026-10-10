import {
  type AuthSessionState,
  type PluginInstallation,
  PluginInstallationId,
  PluginInstallationManifest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "@effect/vitest";

import {
  canManagePlugins,
  createPluginActionGate,
  describePluginSource,
  explainedPluginAccess,
  PLUGIN_ACCESS_CHECKING,
  PLUGIN_MANAGE_ACCESS_REQUIRED,
  PLUGIN_MANAGE_ACCESS_UNREADABLE,
  type PluginActionSubject,
  type PluginManageAccess,
  pluginAccessStatus,
  pluginAddDirectory,
  pluginManagementNotice,
  presentPluginInstallation,
  resolvePluginCatalogState,
  resolvePluginDetail,
  resolvePluginManageAccess,
  startPluginAddHandoff,
} from "./pluginPresentation.ts";
import { deliverPluginCatalog, type PluginCatalogView } from "./plugins.ts";

/** Resolves once the atom's value satisfies `done`, without polling. */
function settled<A>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<A>,
  done: (value: A) => boolean,
): Promise<void> {
  if (done(registry.get(atom))) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = registry.subscribe(atom, (value) => {
      if (!done(value)) return;
      unsubscribe();
      resolve();
    });
  });
}

const DIGEST = `sha256:${"a".repeat(64)}`;
const OLD_DIGEST = `sha256:${"b".repeat(64)}`;

const MANIFEST = Schema.decodeSync(PluginInstallationManifest)({
  id: "acme.notifier",
  name: "Notifier",
  version: "1.0.0",
  capabilities: [],
  proposedApi: false,
});

const installation = (overrides: Partial<PluginInstallation> = {}): PluginInstallation => ({
  installationId: PluginInstallationId.make("installation-1"),
  generation: 1,
  directory: "/srv/plugins/notifier/",
  manifest: MANIFEST,
  source: { digest: DIGEST, files: 3, bytes: 2048 },
  problem: null,
  inspectedAt: "2026-10-04T00:00:00.000Z",
  consent: { digest: DIGEST, capabilities: [], grantedAt: "2026-10-04T00:00:00.000Z" },
  enabled: true,
  hostState: { _tag: "idle" },
  addedAt: "2026-10-04T00:00:00.000Z",
  ...overrides,
});

describe("presentPluginInstallation", () => {
  it("treats an enabled plugin with an unknown host state as unknown, not idle", () => {
    const { hostState: _, ...unknownState } = installation();
    const view = presentPluginInstallation(unknownState);
    expect(view.stateLabel).toBe("Unknown state");
    expect(view.canResume).toBe(false);
    expect(view.canEnable).toBe(false);
    expect(view.canDisable).toBe(true);
  });

  it("asks for a fresh review after the approved bytes changed", () => {
    const view = presentPluginInstallation(
      installation({
        enabled: false,
        hostState: undefined,
        consent: { digest: OLD_DIGEST, capabilities: [], grantedAt: "2026-10-04T00:00:00.000Z" },
      }),
    );
    expect(view.status).toBe("needs-consent");
    expect(view.stateLabel).toBe("Changed since approval");
    expect(view.canReview).toBe(true);
    expect(view.canEnable).toBe(false);
  });

  it("offers a first review to a plugin nobody approved yet", () => {
    const view = presentPluginInstallation(
      installation({ enabled: false, hostState: undefined, consent: null }),
    );
    expect(view.stateLabel).toBe("Needs approval");
    expect(view.canReview).toBe(true);
  });

  it("offers resume only for states that wait for it", () => {
    const resumable = (hostState: PluginInstallation["hostState"]) =>
      presentPluginInstallation(installation({ hostState })).canResume;
    expect(resumable({ _tag: "idle" })).toBe(false);
    expect(resumable({ _tag: "running" })).toBe(false);
    expect(
      resumable({
        _tag: "backoff",
        failures: 2,
        reason: "Exited.",
        retryAt: "2026-10-04T00:01:00.000Z",
      }),
    ).toBe(true);
    expect(resumable({ _tag: "quarantined", failures: 6, reason: "Exited." })).toBe(true);
    expect(resumable({ _tag: "incompatible", reason: "Uses top-level await." })).toBe(true);
  });

  it("keeps disable available for an enabled plugin whose directory became unreadable", () => {
    const view = presentPluginInstallation(
      installation({ source: null, problem: "The directory does not exist." }),
    );
    expect(view.status).toBe("unavailable");
    expect(view.detail).toBe("The directory does not exist.");
    expect(view.canDisable).toBe(true);
    expect(view.canEnable).toBe(false);
  });

  it("names a plugin without a readable manifest by its directory", () => {
    const view = presentPluginInstallation(
      installation({ manifest: null, source: null, problem: "No manifest.", enabled: false }),
    );
    expect(view.title).toBe("notifier");
  });
});

describe("presentPluginInstallation event delivery", () => {
  const EVENTS_MANIFEST = { ...MANIFEST, capabilities: ["events"], proposedApi: true };
  const eventsPlugin = (overrides: Partial<PluginInstallation> = {}) =>
    installation({ manifest: EVENTS_MANIFEST, hostState: { _tag: "running" }, ...overrides });
  const QUARANTINED = {
    _tag: "quarantined",
    failures: 5,
    reason: "notifier is told to fail.",
  } as const;

  it("shows quarantined delivery and offers resume while the process keeps running", () => {
    const view = presentPluginInstallation(eventsPlugin({ eventDelivery: QUARANTINED }));
    expect(view.stateLabel).toBe("Running");
    expect(view.delivery?.label).toBe("Event delivery stopped");
    expect(view.delivery?.tone).toBe("error");
    expect(view.delivery?.detail).toContain("notifier is told to fail.");
    expect(view.canResume).toBe(true);
  });

  it("explains an event the server could not read", () => {
    const view = presentPluginInstallation(
      eventsPlugin({ eventDelivery: { _tag: "quarantined", failures: 0, reason: "Bad row." } }),
    );
    expect(view.delivery?.detail).toContain("An event could not be read.");
    expect(view.canResume).toBe(true);
  });

  it("shows retrying delivery with its reason and offers resume while the process keeps running", () => {
    const view = presentPluginInstallation(
      eventsPlugin({
        eventDelivery: {
          _tag: "retrying",
          failures: 2,
          reason: "Handler timed out.",
          retryAt: "2026-10-04T00:01:00.000Z",
        },
      }),
    );
    expect(view.stateLabel).toBe("Running");
    expect(view.delivery?.label).toBe("Event delivery retrying");
    expect(view.delivery?.detail).toContain("Failed 2 times: Handler timed out.");
    expect(view.canResume).toBe(true);
  });

  it("treats absent delivery as unknown, not healthy", () => {
    const view = presentPluginInstallation(eventsPlugin());
    expect(view.delivery?.label).toBe("Event delivery unknown");
    expect(view.delivery?.tone).not.toBe("success");
    expect(view.canResume).toBe(false);
  });

  it("offers resume for delivery and process failures independently", () => {
    const backoff = {
      _tag: "backoff",
      failures: 1,
      reason: "Exited.",
      retryAt: "2026-10-04T00:01:00.000Z",
    } as const;
    const resumable = (
      hostState: PluginInstallation["hostState"],
      eventDelivery: PluginInstallation["eventDelivery"],
    ) => presentPluginInstallation(eventsPlugin({ hostState, eventDelivery })).canResume;
    expect(resumable({ _tag: "running" }, { _tag: "active" })).toBe(false);
    expect(resumable(backoff, { _tag: "active" })).toBe(true);
    expect(resumable({ _tag: "idle" }, QUARANTINED)).toBe(true);
    expect(resumable(undefined, QUARANTINED)).toBe(true);
  });

  it("clears after resume and hides delivery once disabled or without the events capability", () => {
    const quarantined = presentPluginInstallation(eventsPlugin({ eventDelivery: QUARANTINED }));
    expect(quarantined.canResume).toBe(true);

    // The `plugins.resume` answer already reports active delivery.
    const resumed = presentPluginInstallation(eventsPlugin({ eventDelivery: { _tag: "active" } }));
    expect(resumed.delivery?.label).toBe("Receiving events");
    expect(resumed.canResume).toBe(false);

    // Disable answers with neither process nor delivery state.
    const disabled = presentPluginInstallation(
      eventsPlugin({ enabled: false, hostState: undefined, eventDelivery: undefined }),
    );
    expect(disabled.status).toBe("disabled");
    expect(disabled.delivery).toBeNull();
    expect(disabled.canResume).toBe(false);

    // Re-enabled before the feed reports: unknown again, not the old state.
    const reenabled = presentPluginInstallation(
      eventsPlugin({ generation: 2, hostState: { _tag: "idle" } }),
    );
    expect(reenabled.delivery?.label).toBe("Event delivery unknown");

    const withoutEvents = presentPluginInstallation(installation({ eventDelivery: QUARANTINED }));
    expect(withoutEvents.delivery).toBeNull();
    expect(withoutEvents.canResume).toBe(false);
  });
});

describe("describePluginSource", () => {
  it("summarizes the file count and size", () => {
    expect(describePluginSource({ digest: DIGEST, files: 1, bytes: 512 })).toBe("1 file, 512 B");
    expect(describePluginSource({ digest: DIGEST, files: 12, bytes: 3 * 1024 * 1024 })).toBe(
      "12 files, 3.0 MB",
    );
  });
});

describe("resolvePluginManageAccess", () => {
  it("requires access:write", () => {
    const access = (scopes: ReadonlyArray<string> | undefined) =>
      resolvePluginManageAccess({
        session: {
          authenticated: true,
          ...(scopes === undefined ? {} : { scopes: scopes as never }),
        },
        isPending: false,
        hasError: false,
      });
    expect(access(["orchestration:read", "access:write"])).toBe("granted");
    expect(access(["orchestration:read", "orchestration:operate"])).toBe("denied");
    expect(access(undefined)).toBe("denied");
  });

  it("waits while the session loads and grants nothing when it cannot be read", () => {
    expect(resolvePluginManageAccess({ session: null, isPending: true, hasError: false })).toBe(
      "pending",
    );
    expect(resolvePluginManageAccess({ session: null, isPending: false, hasError: true })).toBe(
      "unreadable",
    );
  });

  it("grants nothing from an earlier read while the current one fails or is in flight", () => {
    const session = { authenticated: true, scopes: ["access:write" as never] };
    expect(resolvePluginManageAccess({ session, isPending: false, hasError: true })).toBe(
      "unreadable",
    );
    expect(resolvePluginManageAccess({ session, isPending: true, hasError: false })).toBe(
      "pending",
    );
  });

  it("drops an administrative read once the credential changes, even if the new read fails", async () => {
    // Mirrors environmentSession.sessionStateAtom: re-read per prepared credential, with SWR.
    const reads = new Map<string, PromiseWithResolvers<AuthSessionState>>();
    const credential = Atom.make("admin");
    const sessionState = Atom.make((get) => {
      const read = Promise.withResolvers<AuthSessionState>();
      reads.set(get(credential), read);
      return Effect.tryPromise(() => read.promise);
    }).pipe(Atom.swr({ staleTime: 30_000, revalidateOnMount: true }));
    const registry = AtomRegistry.make();
    const unmount = registry.mount(sessionState);
    const access = () => {
      const result = registry.get(sessionState);
      return resolvePluginManageAccess({
        session: Option.getOrNull(AsyncResult.value(result)),
        isPending: result.waiting,
        hasError: AsyncResult.isFailure(result),
      });
    };
    try {
      expect(access()).toBe("pending");
      reads.get("admin")!.resolve({ authenticated: true, scopes: ["access:write"] } as never);
      await settled(registry, sessionState, AsyncResult.isSuccess);
      expect(access()).toBe("granted");

      registry.set(credential, "standard");
      expect(access()).toBe("pending");
      reads.get("standard")!.reject(new Error("session read failed"));
      await settled(registry, sessionState, AsyncResult.isFailure);
      // The failed result still carries the administrative read as its previous success.
      expect(Option.getOrNull(AsyncResult.value(registry.get(sessionState)))?.scopes).toEqual([
        "access:write",
      ]);
      expect(access()).toBe("unreadable");
    } finally {
      unmount();
      registry.dispose();
    }
  });
});

const available = (
  installations: ReadonlyArray<PluginInstallation>,
  revision = 0,
): PluginCatalogView => ({ _tag: "available", installations, revision });
const availableState = (view: PluginCatalogView) =>
  resolvePluginCatalogState({ connected: true, data: view, error: null });

describe("plugin management readiness", () => {
  it("manages only with access:write and a live catalogue", () => {
    const live = availableState(available([installation()]));
    expect(canManagePlugins("granted", live)).toBe(true);
    for (const access of ["denied", "pending", "unreadable"] as const)
      expect(canManagePlugins(access, live)).toBe(false);
  });

  it("stops management when the subscription fails, even with a cached snapshot", () => {
    const catalog = resolvePluginCatalogState({
      connected: true,
      data: available([installation()]),
      error: "Subscription lost.",
    });
    expect(catalog).toEqual({ _tag: "failed", message: "Subscription lost." });
    expect(canManagePlugins("granted", catalog)).toBe(false);
  });

  it("stops management while disconnected or loading", () => {
    for (const catalog of [
      resolvePluginCatalogState({ connected: false, data: available([]), error: null }),
      resolvePluginCatalogState({ connected: true, data: null, error: null }),
      resolvePluginCatalogState({ connected: true, data: { _tag: "unsupported" }, error: null }),
    ])
      expect(canManagePlugins("granted", catalog)).toBe(false);
  });
});

describe("pluginAccessStatus", () => {
  const live = availableState(available([]));

  it("explains a pending access check as a short status, with every control off", () => {
    expect(pluginAccessStatus("pending", live)).toBe(PLUGIN_ACCESS_CHECKING);
    expect(canManagePlugins("pending", live)).toBe(false);
    // The short status is all a check shows; no notice block comes and goes with it.
    expect(pluginManagementNotice("pending", live, "Build box")).toBeNull();
  });

  it("keeps explaining the last settled access through a re-check", () => {
    const explain = (lastSettled: PluginManageAccess | null) =>
      pluginManagementNotice(explainedPluginAccess("pending", lastSettled), live, "Build box");
    expect(explain("denied")).toBe(PLUGIN_MANAGE_ACCESS_REQUIRED);
    expect(explain("unreadable")).toBe(PLUGIN_MANAGE_ACCESS_UNREADABLE);
    expect(explain("granted")).toBeNull();
    expect(explain(null)).toBeNull();
    // A settled read replaces what an earlier one explained.
    expect(explainedPluginAccess("granted", "denied")).toBe("granted");
  });

  it("has no status once access is settled, either way", () => {
    for (const access of ["granted", "denied", "unreadable"] as const)
      expect(pluginAccessStatus(access, live)).toBeNull();
    expect(pluginManagementNotice("denied", live, "Build box")).not.toBeNull();
  });

  it("leaves catalogue states to their own notice", () => {
    for (const catalog of [
      resolvePluginCatalogState({ connected: false, data: null, error: null }),
      resolvePluginCatalogState({ connected: true, data: null, error: null }),
      resolvePluginCatalogState({ connected: true, data: available([]), error: "Lost." }),
    ])
      expect(pluginAccessStatus("pending", catalog)).toBeNull();
  });
});

describe("pluginAddDirectory", () => {
  it("sends nothing from a read-only session, even on keyboard submit", () => {
    expect(pluginAddDirectory({ canManage: false, busy: false, directory: "/srv/p" })).toBeNull();
  });

  it("sends nothing once an open add form loses its catalogue", () => {
    const access = "granted" as const;
    const before = availableState(available([]));
    const after = resolvePluginCatalogState({
      connected: true,
      data: available([]),
      error: "Subscription lost.",
    });
    const directory = " /srv/plugins/notifier ";
    expect(
      pluginAddDirectory({ canManage: canManagePlugins(access, before), busy: false, directory }),
    ).toBe("/srv/plugins/notifier");
    expect(
      pluginAddDirectory({ canManage: canManagePlugins(access, after), busy: false, directory }),
    ).toBeNull();
    expect(
      pluginAddDirectory({ canManage: canManagePlugins("denied", before), busy: false, directory }),
    ).toBeNull();
  });

  it("sends nothing while busy or empty", () => {
    expect(pluginAddDirectory({ canManage: true, busy: true, directory: "/srv/p" })).toBeNull();
    expect(pluginAddDirectory({ canManage: true, busy: false, directory: "  " })).toBeNull();
  });
});

describe("resolvePluginDetail", () => {
  const id = PluginInstallationId.make("installation-1");
  const added = installation();
  const MARKED = 7;

  it("shows a just-added plugin until a snapshot delivered after the add lists it", () => {
    const marker = { afterRevision: MARKED, installation: added };
    expect(
      resolvePluginDetail({
        catalog: availableState(available([], MARKED)),
        installationId: id,
        added: marker,
      }),
    ).toEqual({ _tag: "found", installation: added });
    const listed = installation({ enabled: true });
    expect(
      resolvePluginDetail({
        catalog: availableState(available([listed], MARKED + 1)),
        installationId: id,
        added: marker,
      }),
    ).toEqual({ _tag: "found", installation: listed });
  });

  it("waits for a snapshot delivered after the add without the reply, then finds the plugin", () => {
    const marker = { afterRevision: MARKED, installation: null };
    expect(
      resolvePluginDetail({
        catalog: availableState(available([], MARKED)),
        installationId: id,
        added: marker,
      }),
    ).toEqual({ _tag: "loading" });
    expect(
      resolvePluginDetail({
        catalog: availableState(available([added], MARKED + 1)),
        installationId: id,
        added: marker,
      }),
    ).toEqual({ _tag: "found", installation: added });
  });

  it("reports removal when a snapshot delivered after the add does not list the plugin", () => {
    // Covers a removal that reached the client before the detail screen opened.
    for (const reply of [added, null]) {
      expect(
        resolvePluginDetail({
          catalog: availableState(available([], MARKED + 1)),
          installationId: id,
          added: { afterRevision: MARKED, installation: reply },
        }),
      ).toEqual({ _tag: "missing" });
    }
  });

  it("reports an absent plugin opened directly as missing, not loading", () => {
    expect(
      resolvePluginDetail({
        catalog: availableState(available([])),
        installationId: id,
        added: null,
      }),
    ).toEqual({ _tag: "missing" });
  });

  it("shows the subscription failure instead of the cached review data", () => {
    expect(
      resolvePluginDetail({
        catalog: resolvePluginCatalogState({
          connected: true,
          data: available([added]),
          error: "Subscription lost.",
        }),
        installationId: id,
        added: null,
      }),
    ).toEqual({ _tag: "failed", message: "Subscription lost." });
  });
});

describe("startPluginAddHandoff", () => {
  const id = PluginInstallationId.make("installation-1");

  it.each([
    ["without the add reply", null],
    ["with the add reply", installation()],
  ] as const)(
    "ends as missing %s when add and remove coalesce, even if the clock steps back",
    async (_label, reply) => {
      // A subscription that drops repeats: after add+remove the server state equals
      // the old snapshot, so only a restarted subscription delivers it again.
      let serverInstallations: ReadonlyArray<PluginInstallation> = [];
      const catalog = Atom.make(
        Stream.concat(
          Stream.fromEffect(Effect.sync(() => deliverPluginCatalog([...serverInstallations]))),
          Stream.never,
        ),
      );
      const registry = AtomRegistry.make();
      const unmount = registry.mount(catalog);
      const state = () =>
        resolvePluginCatalogState({
          connected: true,
          data: Option.getOrNull(AsyncResult.value(registry.get(catalog))),
          error: null,
        });
      const originalNow = Date.now;
      let now = 2_000;
      Date.now = () => now;
      try {
        await settled(registry, catalog, AsyncResult.isSuccess);
        const before = AsyncResult.getOrThrow(registry.get(catalog));
        // The plugin is added and removed again before the subscription reports either.
        serverInstallations = [installation()];
        serverInstallations = [];

        let restarts = 0;
        const marker = startPluginAddHandoff({
          installation: reply,
          restartCatalog: () => {
            restarts += 1;
            // The device clock is adjusted backwards before the restarted snapshot arrives.
            now = 1_500;
            registry.refresh(catalog);
          },
        });
        expect(restarts).toBe(1);
        await settled(
          registry,
          catalog,
          (result) => AsyncResult.isSuccess(result) && result.value !== before,
        );
        expect(AsyncResult.isSuccess(registry.get(catalog)) && registry.get(catalog)).toMatchObject(
          { timestamp: 1_500 },
        );
        expect(
          resolvePluginDetail({ catalog: state(), installationId: id, added: marker }),
        ).toEqual({ _tag: "missing" });
      } finally {
        Date.now = originalNow;
        unmount();
        registry.dispose();
      }
    },
  );
});

describe("createPluginActionGate", () => {
  const ENVIRONMENT = "environment-1";
  const id = PluginInstallationId.make("installation-1");
  const subject = (overrides: Partial<PluginActionSubject> = {}): PluginActionSubject => ({
    environmentId: ENVIRONMENT,
    installation: installation(),
    acknowledgedDigest: null,
    ...overrides,
  });
  const target = { environmentId: ENVIRONMENT, installationId: id };
  const counted = () => {
    const calls: Array<string> = [];
    const step = (name: string) => () => {
      calls.push(name);
      return Promise.resolve({ value: name });
    };
    return { calls, step };
  };

  it("sends nothing from a confirmation opened before management was lost or its screen closed", async () => {
    const gate = createPluginActionGate();
    const { calls, step } = counted();
    gate.set(subject());
    // A native confirmation keeps the callback it was opened with.
    const confirmRemove = () => gate.run(target, [step("remove")]);
    gate.set(null);
    expect(await confirmRemove()).toEqual({ _tag: "refused" });
    expect(calls).toEqual([]);
  });

  it("sends nothing for a different installation or environment", async () => {
    const gate = createPluginActionGate();
    const { calls, step } = counted();
    gate.set(subject());
    expect(
      await gate.run({ ...target, installationId: PluginInstallationId.make("other") }, [
        step("remove"),
      ]),
    ).toEqual({ _tag: "refused" });
    expect(await gate.run({ ...target, environmentId: "environment-2" }, [step("remove")])).toEqual(
      { _tag: "refused" },
    );
    expect(calls).toEqual([]);
  });

  it("stops between steps when management is lost mid-action", async () => {
    const gate = createPluginActionGate();
    const calls: Array<string> = [];
    gate.set(subject());
    const outcome = await gate.run(target, [
      () => {
        calls.push("consent");
        gate.set(null);
        return Promise.resolve({ value: null });
      },
      () => {
        calls.push("enable");
        return Promise.resolve({ value: null });
      },
    ]);
    expect(outcome).toEqual({ _tag: "refused" });
    expect(calls).toEqual(["consent"]);
  });

  it("approves only the reviewed files with a current acknowledgement", async () => {
    const gate = createPluginActionGate();
    const { calls, step } = counted();
    const approval = { ...target, approvedDigest: DIGEST };
    gate.set(subject());
    expect(await gate.run(approval, [step("consent")])).toEqual({ _tag: "refused" });
    gate.set(
      subject({
        installation: installation({ source: { digest: OLD_DIGEST, files: 3, bytes: 2048 } }),
        acknowledgedDigest: DIGEST,
      }),
    );
    expect(await gate.run(approval, [step("consent")])).toEqual({ _tag: "refused" });
    expect(calls).toEqual([]);
    gate.set(subject({ acknowledgedDigest: DIGEST }));
    expect(await gate.run(approval, [step("consent")])).toEqual({ _tag: "done" });
    expect(calls).toEqual(["consent"]);
  });

  it("never enables after the source changes while consent is in flight", async () => {
    const gate = createPluginActionGate();
    const calls: Array<string> = [];
    let releaseConsent: (value: { readonly value: null }) => void = () => undefined;
    gate.set(subject({ acknowledgedDigest: DIGEST }));
    // Management readiness stays true throughout; only the reviewed subject changes.
    const outcome = gate.run({ ...target, approvedDigest: DIGEST }, [
      () => {
        calls.push("consent");
        return new Promise((resolve) => {
          releaseConsent = resolve;
        });
      },
      () => {
        calls.push("enable");
        return Promise.resolve({ value: null });
      },
    ]);
    // A snapshot reports new files for the same installation; the screen recomputes.
    const changed = installation({ source: { digest: OLD_DIGEST, files: 4, bytes: 4096 } });
    gate.set(subject({ installation: changed, acknowledgedDigest: DIGEST }));
    releaseConsent({ value: null });
    expect(await outcome).toEqual({ _tag: "refused" });
    expect(calls).toEqual(["consent"]);
  });

  it("keeps disable and remove bound to the installation, not its files", async () => {
    const gate = createPluginActionGate();
    const { calls, step } = counted();
    gate.set(
      subject({
        installation: installation({ source: { digest: OLD_DIGEST, files: 4, bytes: 4096 } }),
      }),
    );
    expect(await gate.run(target, [step("disable")])).toEqual({ _tag: "done" });
    expect(calls).toEqual(["disable"]);
  });

  it("runs every step once, one action at a time, and reports the first failure", async () => {
    const gate = createPluginActionGate();
    const { calls, step } = counted();
    gate.set(subject());
    let started = 0;
    const first = gate.run(target, [step("consent"), step("enable")], () => (started += 1));
    expect(await gate.run(target, [step("remove")])).toEqual({ _tag: "refused" });
    expect(await first).toEqual({ _tag: "done" });
    expect(started).toBe(1);
    expect(calls).toEqual(["consent", "enable"]);
    expect(
      await gate.run(target, [() => Promise.resolve({ error: "source-changed" }), step("enable")]),
    ).toEqual({ _tag: "failed", error: "source-changed" });
    expect(calls).toEqual(["consent", "enable"]);
  });
});
