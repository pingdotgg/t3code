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

function updateState(
  status: NonNullable<ServerProvider["updateState"]>["status"],
  finishedAt: string | null = checkedAt,
): NonNullable<ServerProvider["updateState"]> {
  return { status, startedAt: checkedAt, finishedAt, message: "Update result", output: null };
}

describe("provider update actions", () => {
  it("offers each outdated driver once and excludes disabled, current, or unknown versions", () => {
    const codex = provider({ driver: driver("codex") });
    const cursor = provider({ driver: driver("cursor") });
    expect(
      collectProviderUpdateCandidates([
        provider({ driver: driver("codex"), instanceId: instanceId("codex_personal") }),
        codex,
        cursor,
        provider({ driver: driver("claudeAgent"), enabled: false }),
        provider({ driver: driver("opencode"), advisoryStatus: "current" }),
        provider({ driver: driver("grok"), latestVersion: null }),
      ]),
    ).toEqual([codex, cursor]);
  });

  it("blocks conflicting sibling commands without blocking siblings that are already current", () => {
    const candidate = updateCandidate({ driver: driver("claudeAgent") });
    const conflicting = provider({
      driver: candidate.driver,
      instanceId: instanceId("claude_work"),
      updateCommand: "bun add -g @anthropic-ai/claude-code@latest",
    });
    expect(canOneClickUpdateProviderCandidate(candidate, [candidate, conflicting])).toBe(false);

    const current = provider({
      driver: candidate.driver,
      instanceId: conflicting.instanceId,
      version: "1.1.0",
      advisoryStatus: "current",
      canUpdate: false,
      updateCommand: null,
    });
    expect(canOneClickUpdateProviderCandidate(candidate, [candidate, current])).toBe(true);
  });

  it("keeps a running non-default instance visible but prevents another update", () => {
    const candidate = updateCandidate({
      driver: driver("claudeAgent"),
      instanceId: instanceId("claude_work"),
      updateState: updateState("running", null),
    });
    const providers = [provider({ driver: candidate.driver }), candidate];
    expect(hasOneClickUpdateProviderCandidate(candidate, providers)).toBe(true);
    expect(canOneClickUpdateProviderCandidate(candidate, providers)).toBe(false);
    expect(getProviderUpdateSidebarPillView(providers)).toMatchObject({
      tone: "loading",
      title: "Updating Claude",
    });
  });

  it("suppresses incompatible updates in both Settings and bulk actions until policy allows them", () => {
    const installed = provider({ driver: driver("codex") });
    const snapshot = (
      latestVersionStatus: "broken" | "unsupported" | "supported" | "unknown",
    ): ServerProvider => ({
      ...installed,
      compatibilityAdvisory: {
        status: "supported",
        latestVersionStatus,
        message: null,
        recommendedRange: null,
        recommendedVersion: null,
      },
    });
    expect(collectProviderUpdateCandidates([snapshot("broken"), snapshot("unsupported")])).toEqual(
      [],
    );
    expect(isProviderSettingsUpdateCandidate(snapshot("broken"))).toBe(false);
    expect(isProviderSettingsUpdateCandidate(snapshot("unsupported"))).toBe(false);
    expect(collectProviderUpdateCandidates([snapshot("supported")])).toHaveLength(1);
    expect(isProviderSettingsUpdateCandidate(snapshot("supported"))).toBe(true);
    expect(collectProviderUpdateCandidates([snapshot("unknown")])).toHaveLength(1);
    expect(isProviderSettingsUpdateCandidate(snapshot("unknown"))).toBe(true);
  });
});

describe("provider update sidebar pill", () => {
  it("counts running and queued drivers once even with multiple instances", () => {
    expect(
      getProviderUpdateSidebarPillView([
        provider({ driver: driver("codex"), updateState: updateState("running", null) }),
        provider({
          driver: driver("codex"),
          instanceId: instanceId("codex_personal"),
          updateState: updateState("running", null),
        }),
        provider({ driver: driver("cursor"), updateState: updateState("queued", null) }),
      ]),
    ).toMatchObject({
      tone: "loading",
      title: "Updating 2 providers",
      description: "Codex and Cursor updates are in progress.",
    });
  });

  it("replaces an older default-instance failure with the latest sibling success", () => {
    expect(
      getProviderUpdateSidebarPillView([
        provider({ driver: driver("claudeAgent"), updateState: updateState("failed") }),
        provider({
          driver: driver("claudeAgent"),
          instanceId: instanceId("claude_work"),
          version: "1.1.0",
          advisoryStatus: "current",
          updateState: updateState("succeeded", laterCheckedAt),
        }),
      ]),
    ).toMatchObject({ tone: "success", title: "Claude updated: v1.1.0" });
  });

  it("shows the newest result, then undismissed results, without replaying earlier sessions", () => {
    const providers = [
      provider({ driver: driver("claudeAgent"), updateState: updateState("failed") }),
      provider({
        driver: driver("codex"),
        version: "1.1.0",
        advisoryStatus: "current",
        updateState: updateState("succeeded", laterCheckedAt),
      }),
    ];
    const options = { visibleAfterIso: sessionStartedAt };
    const success = getProviderUpdateSidebarPillView(providers, options);
    expect(success).toMatchObject({
      tone: "success",
      title: "Codex updated: v1.1.0",
      dismissAfterVisibleMs: 3_000,
    });

    const dismissedKeys = new Set([success!.key]);
    const failure = getProviderUpdateSidebarPillView(providers, { ...options, dismissedKeys });
    expect(failure).toMatchObject({
      tone: "error",
      title: "Claude v1.1.0 update failed",
      description: "Update result",
      dismissible: true,
    });
    dismissedKeys.add(failure!.key);
    expect(getProviderUpdateSidebarPillView(providers, { ...options, dismissedKeys })).toBeNull();
    expect(
      getProviderUpdateSidebarPillView(providers, { visibleAfterIso: "2026-04-23T10:02:00.000Z" }),
    ).toBeNull();
  });

  it("lets users dismiss an update that left the provider outdated", () => {
    const providers = [
      provider({ driver: driver("cursor"), updateState: updateState("unchanged") }),
    ];
    const view = getProviderUpdateSidebarPillView(providers);
    expect(view).toMatchObject({
      tone: "warning",
      title: "Cursor still needs an update",
      dismissible: true,
    });
    expect(
      getProviderUpdateSidebarPillView(providers, { dismissedKeys: new Set([view!.key]) }),
    ).toBeNull();
  });

  it("stays hidden for passive update availability", () => {
    expect(
      getProviderUpdateSidebarPillView([
        provider({ driver: driver("codex"), canUpdate: true }),
        provider({ driver: driver("cursor"), canUpdate: false }),
      ]),
    ).toBeNull();
  });
});

describe("getProviderUpdateRunToastView", () => {
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
              updateState: updateState("succeeded"),
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
              updateState: { ...updateState("failed"), message: "npm exited with code 1." },
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
          updateState: updateState("succeeded"),
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
