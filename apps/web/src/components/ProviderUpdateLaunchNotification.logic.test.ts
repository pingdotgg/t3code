import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import {
  buildLocalEnvironmentUpdateGroups,
  canOneClickUpdateProviderCandidate,
  collectProviderUpdateOutcomeSnapshots,
  collectUpdatedProviderSnapshots,
  firstRejectedProviderUpdateMessage,
  getProviderUpdateProgressToastView,
  getProviderUpdateRunToastView,
  getProviderUpdateSidebarPillView,
  hasOneClickUpdateProviderCandidate,
  isProviderUpdateCandidate,
  isProviderSettingsUpdateCandidate,
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

  it("shows the active sidebar pill for an update on a non-default instance", () => {
    const view = getProviderUpdateSidebarPillView([
      provider({ driver: driver("claudeAgent") }),
      provider({
        driver: driver("claudeAgent"),
        instanceId: instanceId("claude_work"),
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
      key: "loading:claudeAgent:running",
      tone: "loading",
      title: "Updating Claude",
      description: "Claude update in progress.",
    });
  });

  it("shows the latest terminal sidebar pill across instances of a driver", () => {
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
        provider({
          driver: driver("claudeAgent"),
          instanceId: instanceId("claude_work"),
          version: "1.1.0",
          latestVersion: "1.1.0",
          advisoryStatus: "current",
          updateState: {
            status: "succeeded",
            startedAt: laterCheckedAt,
            finishedAt: laterCheckedAt,
            message: "Provider updated.",
            output: null,
          },
        }),
      ],
      { visibleAfterIso: sessionStartedAt },
    );

    expect(view).toMatchObject({
      key: "succeeded:claudeAgent:2026-04-23T10:01:00.000Z:Provider updated.",
      tone: "success",
      title: "Claude updated: v1.1.0",
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
  });
});

it("does not offer incompatible latest versions and restores suggestions after policy relaxation", () => {
  const installed = provider({ driver: driver("codex") });
  for (const latestVersionStatus of ["broken", "unsupported", "supported", "unknown"] as const) {
    const snapshot: ServerProvider = {
      ...installed,
      compatibilityAdvisory: {
        status: "supported",
        latestVersionStatus,
        message: null,
        recommendedRange: null,
        recommendedVersion: null,
      },
    };
    const expected = latestVersionStatus === "supported" || latestVersionStatus === "unknown";
    expect(isProviderUpdateCandidate(snapshot)).toBe(expected);
    expect(isProviderSettingsUpdateCandidate(snapshot)).toBe(expected);
  }
});

describe("getProviderUpdateRunToastView", () => {
  const updateState = (
    status: "succeeded" | "failed",
    message: string,
  ): ServerProvider["updateState"] => ({
    status,
    startedAt: checkedAt,
    finishedAt: laterCheckedAt,
    message,
    output: null,
  });
  const run = (
    machineLabel: string,
    providerDriver: string,
    result: Parameters<typeof getProviderUpdateRunToastView>[0][number]["result"],
  ) => ({
    environmentId: EnvironmentId.make(machineLabel),
    machineLabel,
    driver: driver(providerDriver),
    instanceId: instanceId(providerDriver),
    result,
  });

  it("lists every failed update and ignores interrupted ones", () => {
    const view = getProviderUpdateRunToastView([
      run(
        "Mac Studio",
        "codex",
        AsyncResult.success({
          providers: [
            provider({
              driver: driver("codex"),
              updateState: updateState("succeeded", "Provider updated."),
            }),
          ],
        }),
      ),
      run(
        "Mac Studio",
        "claudeAgent",
        AsyncResult.success({
          providers: [
            provider({
              driver: driver("claudeAgent"),
              updateState: updateState("failed", "npm exited with code 1."),
            }),
          ],
        }),
      ),
      run("Laptop", "codex", AsyncResult.failure(Cause.die(new Error("WebSocket closed")))),
      run("Server", "codex", AsyncResult.failure(Cause.interrupt())),
    ]);

    expect(view).toEqual({
      type: "error",
      title: "2 of 3 provider updates failed",
      description: "Mac Studio · Claude: npm exited with code 1.\nLaptop · Codex: WebSocket closed",
    });
  });
});
