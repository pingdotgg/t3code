import { describe, expect, it } from "vite-plus/test";
import {
  type EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";

import {
  buildLocalEnvironmentUpdateGroups,
  canOneClickUpdateProviderCandidate,
  collectProviderUpdateCandidates,
  collectProviderUpdateOutcomeSnapshots,
  collectUpdatedProviderSnapshots,
  deriveEnvironmentDisplayLabel,
  environmentGroupsWithUpdates,
  firstFailedProviderUpdateMessage,
  firstRejectedProviderUpdateMessage,
  firstUnsuccessfulSecondaryProviderOutcome,
  getProviderUpdateInitialToastView,
  getProviderUpdateProgressToastView,
  getProviderUpdateRejectedToastView,
  getProviderUpdateSidebarPillView,
  getSingleProviderUpdateProgressToastView,
  hasOneClickUpdateProviderCandidate,
  isProviderUpdateCandidate,
  isTerminalProviderUpdatePhase,
  localEnvironmentUpdateNotificationKey,
  parseWslDistroFromInstanceId,
  providerUpdateNotificationKey,
  resolveEnvironmentUpdateRowStatus,
  type LocalEnvironmentProvidersInput,
  type LocalEnvironmentUpdateGroup,
  type LocalProviderUpdateOutcome,
  type ProviderUpdateCandidate,
  type ProviderUpdateSidebarPillView,
  type ProviderUpdateToastView,
} from "./ProviderUpdateLaunchNotification.logic";

const checkedAt = "2026-04-23T10:00:00.000Z";
const sessionStartedAt = "2026-04-23T09:59:00.000Z";
const laterCheckedAt = "2026-04-23T10:01:00.000Z";

const driver = (value: string) => ProviderDriverKind.make(value);
const instanceId = (value: string) => ProviderInstanceId.make(value);

function provider(input: {
  readonly driver: ReturnType<typeof ProviderDriverKind.make>;
  readonly instanceId?: ReturnType<typeof ProviderInstanceId.make>;
  readonly enabled?: boolean;
  readonly version?: string | null;
  readonly latestVersion?: string | null;
  readonly canUpdate?: boolean;
  readonly updateCommand?: string | null;
  readonly updateState?: ServerProvider["updateState"];
  readonly advisoryStatus?: NonNullable<ServerProvider["versionAdvisory"]>["status"];
}): ServerProvider {
  const result: ServerProvider = {
    instanceId: input.instanceId ?? instanceId(String(input.driver)),
    driver: input.driver,
    enabled: input.enabled ?? true,
    installed: true,
    version: input.version ?? "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: input.advisoryStatus ?? "behind_latest",
      currentVersion: input.version ?? "1.0.0",
      latestVersion: "latestVersion" in input ? input.latestVersion : "1.1.0",
      updateCommand: "updateCommand" in input ? input.updateCommand : "npm install -g provider",
      canUpdate: input.canUpdate ?? true,
      checkedAt,
      message: "Update available.",
    },
  };

  if (input.updateState) {
    return { ...result, updateState: input.updateState };
  }

  return result;
}

function updateCandidate(input: Parameters<typeof provider>[0]): ProviderUpdateCandidate {
  return provider(input) as ProviderUpdateCandidate;
}

describe("provider update launch notification logic", () => {
  it("detects enabled providers with a latest-version advisory", () => {
    expect(isProviderUpdateCandidate(provider({ driver: driver("codex") }))).toBe(true);
    expect(isProviderUpdateCandidate(provider({ driver: driver("codex"), enabled: false }))).toBe(
      false,
    );
    expect(
      isProviderUpdateCandidate(
        provider({ driver: driver("codex"), advisoryStatus: "current", latestVersion: null }),
      ),
    ).toBe(false);
    expect(
      isProviderUpdateCandidate(provider({ driver: driver("codex"), latestVersion: null })),
    ).toBe(false);
  });

  it("deduplicates multi-instance provider candidates by driver", () => {
    expect(
      collectProviderUpdateCandidates([
        provider({
          driver: driver("codex"),
          instanceId: instanceId("codex_personal"),
          latestVersion: "1.1.0",
        }),
        provider({
          driver: driver("codex"),
          instanceId: instanceId("codex"),
          latestVersion: "1.1.0",
        }),
        provider({ driver: driver("cursor"), latestVersion: "0.3.0" }),
      ]),
    ).toHaveLength(2);
  });

  it("disables one-click updates when provider instances disagree on the update command", () => {
    const candidate = updateCandidate({
      driver: driver("claudeAgent"),
      instanceId: instanceId("claude_personal"),
      latestVersion: "2.1.123",
    });

    expect(
      canOneClickUpdateProviderCandidate(candidate, [
        candidate,
        provider({
          driver: driver("claudeAgent"),
          instanceId: instanceId("claude_work"),
          latestVersion: "2.1.123",
          canUpdate: true,
          updateCommand: "bun add -g @anthropic-ai/claude-code@latest",
        }),
      ]),
    ).toBe(false);
  });

  it("keeps one-click updates enabled when sibling instances are already current", () => {
    const candidate = updateCandidate({
      driver: driver("claudeAgent"),
      instanceId: instanceId("claude_personal"),
      latestVersion: "2.1.123",
      updateCommand: "npm install -g @anthropic-ai/claude-code@latest",
    });

    expect(
      hasOneClickUpdateProviderCandidate(candidate, [
        candidate,
        provider({
          driver: driver("claudeAgent"),
          instanceId: instanceId("claude_work"),
          version: "2.1.123",
          latestVersion: "2.1.123",
          advisoryStatus: "current",
          canUpdate: false,
          updateCommand: null,
        }),
      ]),
    ).toBe(true);
    expect(
      canOneClickUpdateProviderCandidate(candidate, [
        candidate,
        provider({
          driver: driver("claudeAgent"),
          instanceId: instanceId("claude_work"),
          version: "2.1.123",
          latestVersion: "2.1.123",
          advisoryStatus: "current",
          canUpdate: false,
          updateCommand: null,
        }),
      ]),
    ).toBe(true);
  });

  it("keeps the inline update action available while a provider update is already running", () => {
    const candidate = updateCandidate({
      driver: driver("codex"),
      updateState: {
        status: "running",
        startedAt: checkedAt,
        finishedAt: null,
        message: "Updating provider.",
        output: null,
      },
    });

    expect(hasOneClickUpdateProviderCandidate(candidate, [candidate])).toBe(true);
    expect(canOneClickUpdateProviderCandidate(candidate, [candidate])).toBe(false);
  });

  it("builds a notification key from provider latest versions", () => {
    const codex = updateCandidate({
      driver: driver("codex"),
      version: "1.0.0",
      latestVersion: "1.1.0",
    });
    const cursor = updateCandidate({
      driver: driver("cursor"),
      version: "0.2.0",
      latestVersion: "0.3.0",
    });

    expect(providerUpdateNotificationKey([codex, cursor])).toBe("codex:1.1.0|cursor:0.3.0");
    expect(providerUpdateNotificationKey([])).toBeNull();
  });

  it("keeps the same notification key while the published update version is unchanged", () => {
    const first = updateCandidate({
      driver: driver("codex"),
      version: "1.0.0",
      latestVersion: "1.2.0",
    });
    const second = updateCandidate({
      driver: driver("codex"),
      version: "1.1.0",
      latestVersion: "1.2.0",
    });
    const nextPublishedVersion = updateCandidate({
      driver: driver("codex"),
      version: "1.1.0",
      latestVersion: "1.3.0",
    });

    expect(providerUpdateNotificationKey([first])).toBe(providerUpdateNotificationKey([second]));
    expect(providerUpdateNotificationKey([nextPublishedVersion])).not.toBe(
      providerUpdateNotificationKey([first]),
    );
  });

  it("tracks updated provider snapshots by instance instead of collapsing to a sibling driver", () => {
    const targetInstanceId = instanceId("codex_personal");
    const siblingInstanceId = instanceId("codex");
    const updatedPersonal = provider({
      driver: driver("codex"),
      instanceId: targetInstanceId,
      version: "1.1.0",
      latestVersion: "1.1.0",
      advisoryStatus: "current",
      updateState: {
        status: "succeeded",
        startedAt: checkedAt,
        finishedAt: checkedAt,
        message: "Provider updated.",
        output: null,
      },
    });
    const currentDefaultSibling = provider({
      driver: driver("codex"),
      instanceId: siblingInstanceId,
      version: "1.1.0",
      latestVersion: "1.1.0",
      advisoryStatus: "current",
      updateState: undefined,
    });

    expect(
      collectUpdatedProviderSnapshots({
        results: [
          AsyncResult.success({
            providers: [updatedPersonal, currentDefaultSibling],
          }),
        ],
        providerInstanceIds: new Set([targetInstanceId]),
      }),
    ).toEqual([updatedPersonal]);
  });

  it("describes a single one-click update", () => {
    const view = getProviderUpdateInitialToastView({
      updateProviders: [updateCandidate({ driver: driver("codex"), latestVersion: "1.1.0" })],
      oneClickProviders: [updateCandidate({ driver: driver("codex"), latestVersion: "1.1.0" })],
    });

    expect(view).toMatchObject({
      phase: "initial",
      type: "warning",
      title: "Update Available: Codex v1.1.0",
      description: "Install the update now or review provider settings.",
    });
  });

  it("describes settings-only updates without one-click support", () => {
    const view = getProviderUpdateInitialToastView({
      updateProviders: [
        updateCandidate({ driver: driver("codex"), canUpdate: false }),
        updateCandidate({ driver: driver("cursor"), canUpdate: false }),
      ],
      oneClickProviders: [],
    });

    expect(view.description).toBe("Codex and Cursor can be updated from provider settings.");
  });

  it("uses server update state for running progress", () => {
    const view = getProviderUpdateProgressToastView({
      providers: [
        provider({
          driver: driver("codex"),
          updateState: {
            status: "running",
            startedAt: checkedAt,
            finishedAt: null,
            message: "Updating provider.",
            output: null,
          },
        }),
      ],
      providerCount: 1,
    });

    expect(view).toMatchObject({
      phase: "running",
      type: "loading",
      title: "Updating provider",
    });
  });

  it("uses server failure state for failed progress", () => {
    const view = getProviderUpdateProgressToastView({
      providers: [
        provider({
          driver: driver("codex"),
          updateState: {
            status: "failed",
            startedAt: checkedAt,
            finishedAt: checkedAt,
            message: "command failed",
            output: "stderr",
          },
        }),
      ],
      providerCount: 1,
    });

    expect(view).toMatchObject({
      phase: "failed",
      type: "error",
      title: "Provider update failed",
      description: "command failed",
    });
  });

  it("resolves a single-provider completion view from the returned provider snapshot", () => {
    const view = getSingleProviderUpdateProgressToastView(
      provider({
        driver: driver("codex"),
        updateState: {
          status: "failed",
          startedAt: checkedAt,
          finishedAt: checkedAt,
          message: "command failed",
          output: "stderr",
        },
      }),
    );

    expect(view).toMatchObject({
      phase: "failed",
      type: "error",
      title: "Codex v1.1.0 update failed",
      description: "command failed",
    });
  });

  it("keeps unchanged providers actionable from settings", () => {
    const view = getProviderUpdateProgressToastView({
      providers: [
        provider({
          driver: driver("cursor"),
          updateState: {
            status: "unchanged",
            startedAt: checkedAt,
            finishedAt: checkedAt,
            message: "still old",
            output: null,
          },
        }),
      ],
      providerCount: 1,
    });

    expect(view).toMatchObject({
      phase: "unchanged",
      type: "warning",
      title: "Provider still needs an update",
      description: "Cursor still appears outdated. Check provider settings for details.",
    });
  });

  it("marks progress succeeded once every attempted provider is no longer outdated", () => {
    const view = getProviderUpdateProgressToastView({
      providers: [
        provider({
          driver: driver("codex"),
          version: "1.1.0",
          latestVersion: "1.1.0",
          advisoryStatus: "current",
          updateState: {
            status: "succeeded",
            startedAt: checkedAt,
            finishedAt: checkedAt,
            message: "Provider updated.",
            output: null,
          },
        }),
      ],
      providerCount: 1,
    });

    expect(view).toMatchObject({
      phase: "succeeded",
      type: "success",
      title: "Provider updated",
      description: "New sessions will use the updated provider.",
      dismissAfterVisibleMs: 3_000,
    });
  });

  it("uses the updated version in the single-provider success toast title", () => {
    const view = getSingleProviderUpdateProgressToastView(
      provider({
        driver: driver("codex"),
        version: "1.1.0",
        latestVersion: "1.1.0",
        advisoryStatus: "current",
        updateState: {
          status: "succeeded",
          startedAt: checkedAt,
          finishedAt: checkedAt,
          message: "Provider updated.",
          output: null,
        },
      }),
    );

    expect(view).toMatchObject({
      phase: "succeeded",
      type: "success",
      title: "Codex updated: v1.1.0",
      description: "New sessions will use the updated provider.",
    });
  });

  it("falls back to a rejected RPC message for transport-level failures", () => {
    const results = [AsyncResult.failure(Cause.die(new Error("WebSocket closed")))];

    expect(firstFailedProviderUpdateMessage(results)).toBe("WebSocket closed");
    expect(getProviderUpdateRejectedToastView(2, "WebSocket closed")).toMatchObject({
      phase: "failed",
      title: "Provider updates failed",
      description: "WebSocket closed",
    });
  });

  it("collects only attempted provider snapshots from update responses", () => {
    const codex = provider({ driver: driver("codex") });
    const cursor = provider({ driver: driver("cursor") });
    const results = [AsyncResult.success({ providers: [codex, cursor] })];

    expect(
      collectUpdatedProviderSnapshots({
        results,
        providerInstanceIds: new Set([cursor.instanceId]),
      }),
    ).toEqual([cursor]);
  });

  it("summarizes active provider updates for the sidebar pill", () => {
    const view = getProviderUpdateSidebarPillView([
      provider({
        driver: driver("codex"),
        updateState: {
          status: "running",
          startedAt: checkedAt,
          finishedAt: null,
          message: "Updating provider.",
          output: null,
        },
      }),
      provider({
        driver: driver("cursor"),
        updateState: {
          status: "queued",
          startedAt: null,
          finishedAt: null,
          message: "Waiting for another provider update to finish.",
          output: null,
        },
      }),
    ]);

    expect(view).toMatchObject({
      tone: "loading",
      title: "Updating 2 providers",
      description: "Codex and Cursor updates are in progress.",
    });
  });

  it("uses the provider name for single active sidebar pill updates", () => {
    const view = getProviderUpdateSidebarPillView([
      provider({
        driver: driver("codex"),
        updateState: {
          status: "running",
          startedAt: checkedAt,
          finishedAt: null,
          message: "Updating provider.",
          output: null,
        },
      }),
    ]);

    expect(view).toMatchObject({
      key: "loading:codex:running",
      tone: "loading",
      title: "Updating Codex",
      description: "Codex update in progress.",
    });
  });

  it("uses the provider name for single failed sidebar pill updates", () => {
    const view = getProviderUpdateSidebarPillView(
      [
        provider({
          driver: driver("claudeAgent"),
          updateState: {
            status: "failed",
            startedAt: checkedAt,
            finishedAt: checkedAt,
            message: "Update command exited with code 1.",
            output: null,
          },
        }),
      ],
      { visibleAfterIso: sessionStartedAt },
    );

    expect(view).toMatchObject({
      key: "failed:claudeAgent:2026-04-23T10:00:00.000Z:Update command exited with code 1.",
      tone: "error",
      title: "Claude v1.1.0 update failed",
      description: "Update command exited with code 1.",
      dismissible: true,
    });
  });

  it("shows a short-lived success sidebar pill after a single provider update succeeds", () => {
    const view = getProviderUpdateSidebarPillView(
      [
        provider({
          driver: driver("codex"),
          version: "1.1.0",
          latestVersion: "1.1.0",
          advisoryStatus: "current",
          updateState: {
            status: "succeeded",
            startedAt: checkedAt,
            finishedAt: checkedAt,
            message: "Provider updated.",
            output: null,
          },
        }),
      ],
      { visibleAfterIso: sessionStartedAt },
    );

    expect(view).toMatchObject({
      key: "succeeded:codex:2026-04-23T10:00:00.000Z:Provider updated.",
      tone: "success",
      title: "Codex updated: v1.1.0",
      description: "New sessions will use the updated provider.",
      dismissAfterVisibleMs: 3_000,
    });
  });

  it("keeps unchanged sidebar pill states dismissible", () => {
    const view = getProviderUpdateSidebarPillView(
      [
        provider({
          driver: driver("cursor"),
          updateState: {
            status: "unchanged",
            startedAt: checkedAt,
            finishedAt: checkedAt,
            message: "still old",
            output: null,
          },
        }),
      ],
      { visibleAfterIso: sessionStartedAt },
    );

    expect(view).toMatchObject({
      key: "unchanged:cursor:2026-04-23T10:00:00.000Z:still old",
      tone: "warning",
      title: "Cursor still needs an update",
      dismissible: true,
    });
  });

  it("does not show sidebar terminal states from before the current app session", () => {
    expect(
      getProviderUpdateSidebarPillView(
        [
          provider({
            driver: driver("codex"),
            updateState: {
              status: "failed",
              startedAt: checkedAt,
              finishedAt: checkedAt,
              message: "command failed",
              output: "stderr",
            },
          }),
        ],
        { visibleAfterIso: "2026-04-23T10:00:01.000Z" },
      ),
    ).toBeNull();
  });

  it("shows a newer success before falling back to an older failure", () => {
    const providers = [
      provider({
        driver: driver("claudeAgent"),
        updateState: {
          status: "failed",
          startedAt: checkedAt,
          finishedAt: checkedAt,
          message: "Update command exited with code 1.",
          output: null,
        },
      }),
      provider({
        driver: driver("codex"),
        version: "1.2.0",
        latestVersion: "1.2.0",
        advisoryStatus: "current",
        updateState: {
          status: "succeeded",
          startedAt: laterCheckedAt,
          finishedAt: laterCheckedAt,
          message: "Provider updated.",
          output: null,
        },
      }),
    ] satisfies ReadonlyArray<ServerProvider>;

    const successView = getProviderUpdateSidebarPillView(providers, {
      visibleAfterIso: sessionStartedAt,
    });
    expect(successView).toMatchObject({
      key: "succeeded:codex:2026-04-23T10:01:00.000Z:Provider updated.",
      tone: "success",
      title: "Codex updated: v1.2.0",
    });

    const failureView = getProviderUpdateSidebarPillView(providers, {
      visibleAfterIso: sessionStartedAt,
      dismissedKeys: new Set(["succeeded:codex:2026-04-23T10:01:00.000Z:Provider updated."]),
    });
    expect(failureView).toMatchObject({
      key: "failed:claudeAgent:2026-04-23T10:00:00.000Z:Update command exited with code 1.",
      tone: "error",
      title: "Claude v1.1.0 update failed",
    });
  });

  it("does not show a sidebar pill for passive update availability", () => {
    expect(
      getProviderUpdateSidebarPillView([
        provider({ driver: driver("codex"), canUpdate: true }),
        provider({ driver: driver("cursor"), canUpdate: false }),
      ]),
    ).toBeNull();
  });

  describe("multi-backend update outcomes", () => {
    const terminalState = (
      status: "succeeded" | "failed" | "unchanged",
      message: string,
    ): NonNullable<ServerProvider["updateState"]> => ({
      status,
      startedAt: checkedAt,
      finishedAt: checkedAt,
      message,
      output: null,
    });

    const fulfilledOutcome = (
      isPrimary: boolean,
      snapshot: ServerProvider | null,
      environment = "env",
    ): PromiseSettledResult<LocalProviderUpdateOutcome> => ({
      status: "fulfilled",
      value: {
        environmentId: environment as LocalProviderUpdateOutcome["environmentId"],
        isPrimary,
        driver: snapshot?.driver ?? driver("codex"),
        instanceId: snapshot?.instanceId ?? instanceId("codex"),
        provider: snapshot,
      },
    });

    it("surfaces a secondary backend's failed update over the primary's success", () => {
      const snapshots = collectProviderUpdateOutcomeSnapshots([
        fulfilledOutcome(
          true,
          provider({
            driver: driver("codex"),
            updateState: terminalState("succeeded", "Provider updated."),
          }),
        ),
        fulfilledOutcome(
          false,
          provider({
            driver: driver("codex"),
            updateState: terminalState("failed", "npm: NotFound"),
          }),
        ),
      ]);

      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]?.updateState?.status).toBe("failed");
      expect(
        getProviderUpdateProgressToastView({ providers: snapshots, providerCount: 1 }),
      ).toMatchObject({ phase: "failed" });
    });

    it("surfaces a secondary backend that stayed outdated over the primary's success", () => {
      const snapshots = collectProviderUpdateOutcomeSnapshots([
        fulfilledOutcome(
          true,
          provider({
            driver: driver("codex"),
            updateState: terminalState("succeeded", "Provider updated."),
          }),
        ),
        fulfilledOutcome(
          false,
          provider({
            driver: driver("codex"),
            updateState: terminalState("unchanged", "still outdated"),
          }),
        ),
      ]);

      expect(snapshots[0]?.updateState?.status).toBe("unchanged");
      expect(
        getProviderUpdateProgressToastView({ providers: snapshots, providerCount: 1 }),
      ).toMatchObject({ phase: "unchanged" });
    });

    it("reports success only when every backend succeeded", () => {
      const snapshots = collectProviderUpdateOutcomeSnapshots([
        fulfilledOutcome(
          true,
          provider({
            driver: driver("codex"),
            updateState: terminalState("succeeded", "Provider updated."),
          }),
        ),
        fulfilledOutcome(
          false,
          provider({
            driver: driver("codex"),
            updateState: terminalState("succeeded", "Provider updated."),
          }),
        ),
      ]);

      expect(
        getProviderUpdateProgressToastView({ providers: snapshots, providerCount: 1 }),
      ).toMatchObject({ phase: "succeeded" });
    });

    it("ignores backends that did not return the targeted instance", () => {
      const primary = provider({
        driver: driver("codex"),
        updateState: terminalState("succeeded", "Provider updated."),
      });
      const snapshots = collectProviderUpdateOutcomeSnapshots([
        fulfilledOutcome(true, primary),
        fulfilledOutcome(false, null),
      ]);

      expect(snapshots).toEqual([primary]);
    });

    it("flags the first unsuccessful secondary outcome, skipping the primary and successes", () => {
      const primaryFailed = provider({
        driver: driver("codex"),
        updateState: terminalState("failed", "primary boom"),
      });

      expect(
        firstUnsuccessfulSecondaryProviderOutcome([
          fulfilledOutcome(true, primaryFailed),
          fulfilledOutcome(
            false,
            provider({
              driver: driver("codex"),
              updateState: terminalState("succeeded", "ok"),
            }),
          ),
        ]),
      ).toBeNull();

      expect(
        firstUnsuccessfulSecondaryProviderOutcome([
          fulfilledOutcome(true, primaryFailed),
          fulfilledOutcome(
            false,
            provider({
              driver: driver("codex"),
              updateState: terminalState("failed", "wsl boom"),
            }),
          ),
        ]),
      ).toMatchObject({ status: "failed", provider: { updateState: { message: "wsl boom" } } });
    });

    it("treats a rejected dispatch as not contributing a snapshot", () => {
      const primary = provider({
        driver: driver("codex"),
        updateState: terminalState("succeeded", "Provider updated."),
      });
      const results: PromiseSettledResult<LocalProviderUpdateOutcome>[] = [
        fulfilledOutcome(true, primary),
        { status: "rejected", reason: new Error("WebSocket closed") },
      ];

      expect(collectProviderUpdateOutcomeSnapshots(results)).toEqual([primary]);
      expect(firstRejectedProviderUpdateMessage(results)).toBe("WebSocket closed");
    });
  });

  describe("per-environment update grouping", () => {
    const environment = (
      input: {
        readonly environmentId: string;
        readonly providers: ReadonlyArray<ServerProvider>;
      } & Partial<Omit<LocalEnvironmentProvidersInput, "environmentId" | "providers">>,
    ): LocalEnvironmentProvidersInput => ({
      environmentId: input.environmentId as EnvironmentId,
      label: input.label ?? input.environmentId,
      isPrimary: input.isPrimary ?? false,
      connectionState: input.connectionState ?? "ready",
      providers: input.providers,
    });

    it("groups each environment's outdated one-click candidates", () => {
      const result = buildLocalEnvironmentUpdateGroups([
        environment({
          environmentId: "env-windows",
          label: "Windows",
          isPrimary: true,
          providers: [provider({ driver: driver("codex"), latestVersion: "1.1.0" })],
        }),
        environment({
          environmentId: "env-wsl",
          label: "WSL",
          providers: [provider({ driver: driver("codex"), latestVersion: "1.1.0" })],
        }),
      ]);

      expect(result.isAnySettling).toBe(false);
      expect(result.groups.map((group) => group.label)).toEqual(["Windows", "WSL"]);
      expect(result.groups.every((group) => group.candidates.length === 1)).toBe(true);
    });

    it("flags settling while a secondary backend is still connecting", () => {
      const result = buildLocalEnvironmentUpdateGroups([
        environment({
          environmentId: "env-windows",
          isPrimary: true,
          providers: [provider({ driver: driver("codex") })],
        }),
        environment({ environmentId: "env-wsl", connectionState: "connecting", providers: [] }),
      ]);

      expect(result.isAnySettling).toBe(true);
      expect(
        result.groups.find((group) => group.environmentId === ("env-wsl" as EnvironmentId))
          ?.isSettling,
      ).toBe(true);
    });

    it("keeps only environments that have a one-click update on offer", () => {
      const { groups } = buildLocalEnvironmentUpdateGroups([
        environment({
          environmentId: "env-windows",
          isPrimary: true,
          providers: [provider({ driver: driver("codex") })],
        }),
        environment({
          environmentId: "env-wsl",
          providers: [
            provider({ driver: driver("codex"), advisoryStatus: "current", latestVersion: null }),
          ],
        }),
      ]);

      expect(environmentGroupsWithUpdates(groups).map((group) => group.environmentId)).toEqual([
        "env-windows",
      ]);
    });

    it("keys the notification by environment, driver and latest version", () => {
      const noUpdates = buildLocalEnvironmentUpdateGroups([
        environment({
          environmentId: "env-windows",
          isPrimary: true,
          providers: [
            provider({ driver: driver("codex"), advisoryStatus: "current", latestVersion: null }),
          ],
        }),
      ]);
      expect(localEnvironmentUpdateNotificationKey(noUpdates.groups)).toBeNull();

      const both = buildLocalEnvironmentUpdateGroups([
        environment({
          environmentId: "env-windows",
          isPrimary: true,
          providers: [provider({ driver: driver("codex"), latestVersion: "1.1.0" })],
        }),
        environment({
          environmentId: "env-wsl",
          providers: [provider({ driver: driver("codex"), latestVersion: "1.1.0" })],
        }),
      ]);
      const key = localEnvironmentUpdateNotificationKey(both.groups);
      expect(key).toContain("env-windows=codex:1.1.0");
      expect(key).toContain("env-wsl=codex:1.1.0");
    });

    it("labels environments by platform so they are distinguishable", () => {
      expect(
        deriveEnvironmentDisplayLabel({
          isWsl: false,
          wslDistro: null,
          platformOs: "windows",
          fallbackLabel: "Jgratton24",
        }),
      ).toBe("Windows");
      expect(
        deriveEnvironmentDisplayLabel({
          isWsl: true,
          wslDistro: null,
          platformOs: "linux",
          fallbackLabel: "Jgratton24",
        }),
      ).toBe("WSL");
      expect(
        deriveEnvironmentDisplayLabel({
          isWsl: true,
          wslDistro: "ubuntu",
          platformOs: "linux",
          fallbackLabel: "Jgratton24",
        }),
      ).toBe("WSL · ubuntu");
      expect(
        deriveEnvironmentDisplayLabel({
          isWsl: false,
          wslDistro: null,
          platformOs: undefined,
          fallbackLabel: "My Device",
        }),
      ).toBe("My Device");
    });

    it("parses the WSL distro from the backend instance id", () => {
      expect(parseWslDistroFromInstanceId("wsl:ubuntu")).toBe("ubuntu");
      expect(parseWslDistroFromInstanceId("wsl:default")).toBeNull();
      expect(parseWslDistroFromInstanceId("wsl:")).toBeNull();
      expect(parseWslDistroFromInstanceId("ssh:host")).toBeNull();
      expect(parseWslDistroFromInstanceId(undefined)).toBeNull();
    });
  });

  describe("isTerminalProviderUpdatePhase", () => {
    it("treats succeeded/failed/unchanged as terminal", () => {
      expect(isTerminalProviderUpdatePhase("succeeded")).toBe(true);
      expect(isTerminalProviderUpdatePhase("failed")).toBe(true);
      expect(isTerminalProviderUpdatePhase("unchanged")).toBe(true);
    });

    it("treats running/initial as non-terminal so they are not persisted", () => {
      // The per-environment update row uses this to decide what to store. A
      // "running"/"initial" snapshot never re-polls, so persisting it would pin
      // the row's spinner forever once pending clears (see the
      // resolveEnvironmentUpdateRowStatus "keeps a non-terminal result on
      // loading even after pending clears" case). Dropping these lets the live
      // per-environment provider state drive the row so it self-heals.
      expect(isTerminalProviderUpdatePhase("running")).toBe(false);
      expect(isTerminalProviderUpdatePhase("initial")).toBe(false);
    });
  });

  describe("resolveEnvironmentUpdateRowStatus", () => {
    const group: LocalEnvironmentUpdateGroup = {
      environmentId: "env-wsl" as EnvironmentId,
      label: "WSL",
      isPrimary: false,
      isSettling: false,
      candidates: [updateCandidate({ driver: driver("codex"), latestVersion: "1.1.0" })],
      providers: [],
    };
    const runningResult: ProviderUpdateToastView = {
      phase: "running",
      type: "loading",
      title: "Updating providers",
      description: "Running provider update command.",
    };
    const succeededResult: ProviderUpdateToastView = {
      phase: "succeeded",
      type: "success",
      title: "Provider updated",
      description: "New sessions will use the updated provider.",
    };
    const successPill: ProviderUpdateSidebarPillView = {
      key: "succeeded:codex",
      tone: "success",
      title: "Codex updated",
      description: "New sessions will use the updated provider.",
    };

    it("prefers a transport error", () => {
      expect(
        resolveEnvironmentUpdateRowStatus({
          group,
          error: "boom",
          result: succeededResult,
          pill: successPill,
          isPending: true,
        }),
      ).toMatchObject({ kind: "failed", text: "boom" });
    });

    it("uses a terminal result snapshot", () => {
      expect(
        resolveEnvironmentUpdateRowStatus({
          group,
          error: undefined,
          result: succeededResult,
          pill: null,
          isPending: false,
        }),
      ).toMatchObject({ kind: "success" });
    });

    it("falls through a non-terminal result to live server state", () => {
      // The dispatch snapshot is still "running", but server state already
      // reports success — the row must not stay pinned on "Updating…".
      expect(
        resolveEnvironmentUpdateRowStatus({
          group,
          error: undefined,
          result: runningResult,
          pill: successPill,
          isPending: true,
        }),
      ).toMatchObject({ kind: "success" });
    });

    it("shows the pending spinner before any signal arrives", () => {
      expect(
        resolveEnvironmentUpdateRowStatus({
          group,
          error: undefined,
          result: runningResult,
          pill: null,
          isPending: true,
        }),
      ).toMatchObject({ kind: "loading" });
    });

    it("keeps a non-terminal result on loading even after pending clears", () => {
      // The dispatch returned an incomplete ("running") snapshot and pending was
      // cleared in finally — the row must not revert to the idle Update button.
      expect(
        resolveEnvironmentUpdateRowStatus({
          group,
          error: undefined,
          result: runningResult,
          pill: null,
          isPending: false,
        }),
      ).toMatchObject({ kind: "loading" });
    });

    it("lists the providers when idle", () => {
      expect(
        resolveEnvironmentUpdateRowStatus({
          group,
          error: undefined,
          result: undefined,
          pill: null,
          isPending: false,
        }),
      ).toMatchObject({ kind: "idle", text: "Codex" });
    });
  });
});
