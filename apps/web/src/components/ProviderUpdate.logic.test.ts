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
  canOneClickUpdateProviderCandidate,
  collectProviderUpdateCandidates,
  getProviderUpdateRunToastView,
  getProviderUpdateSidebarPillView,
  hasOneClickUpdateProviderCandidate,
  isProviderUpdateCandidate,
  isProviderSettingsUpdateCandidate,
  type ProviderUpdateCandidate,
} from "./ProviderUpdate.logic";

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

describe("provider update logic", () => {
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

  it("reports success when every update succeeded", () => {
    const succeeded = AsyncResult.success({
      providers: [
        provider({
          driver: driver("codex"),
          updateState: updateState("succeeded", "Provider updated."),
        }),
      ],
    });

    expect(
      getProviderUpdateRunToastView([
        run("Mac Studio", "codex", succeeded),
        run("Laptop", "codex", succeeded),
      ]),
    ).toEqual({
      type: "success",
      title: "2 providers updated",
      description: "New sessions will use the updated providers.",
    });
    expect(
      getProviderUpdateRunToastView([
        run("Server", "codex", AsyncResult.failure(Cause.interrupt())),
      ]),
    ).toBeNull();
  });
});
