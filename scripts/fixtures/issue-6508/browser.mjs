// Run through preview_evaluate on an owned, paired tab of the actual Vite app.
export async function reset({
  theme = "light",
  project = "B",
  nonempty = false,
  explicit = false,
} = {}) {
  const { useComposerDraftStore: s } = await import("/src/composerDraftStore.ts");
  s.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    backgroundSubmissionThreadKeys: {},
    stickyModelSelectionByProvider: {},
    stickyOptionsByModelByProvider: {},
    stickyActiveProvider: null,
  });
  const { updateClientSettings } = await import("/src/hooks/useSettings.ts");
  await updateClientSettings({
    planModeEnabled: true,
    onboardingCompletedAt: "2026-10-22T10:00:00.000Z",
    legacySidebarEnabled: true,
    sidebarProjectGroupingMode: "separate",
    panelAnimationDurationMs: 0,
  });
  localStorage.setItem("t3code:theme", theme);
  if (nonempty) {
    const id = "issue-6508-draft";
    const a = s.getState();
    a.setProjectDraftThreadId(
      { environmentId: "issue-6508-E1", projectId: `proof-E1-${project}` },
      id,
      {
        threadId: "issue-6508-draft-thread",
        createdAt: "2026-10-22T10:00:00.000Z",
        runtimeMode: "approval-required",
        interactionMode: "default",
        envMode: "local",
        branch: null,
        worktreePath: null,
        startFromOrigin: false,
      },
    );
    a.setModelSelection(
      id,
      {
        instanceId: "codex",
        model: "gpt-6-luna",
        options: [{ id: "reasoningEffort", value: "low" }],
      },
      { explicit: false, replaceOptions: true },
    );
    a.setPrompt(id, "Issue 6508 deterministic submission.");
    if (explicit) {
      a.setModelSelection(
        id,
        {
          instanceId: "codex",
          model: "gpt-6-astra",
          options: [{ id: "reasoningEffort", value: "medium" }],
        },
        { explicit: true, replaceOptions: true },
      );
      a.setRuntimeMode(id, "full-access");
      a.setInteractionMode(id, "default");
    }
  }
  return localStorage.getItem("t3code:composer-drafts:v1");
}
export function freezeClock() {
  const RealDate = globalThis.Date;
  const ms = RealDate.parse("2026-10-22T10:00:00.000Z");
  globalThis.Date = class extends RealDate {
    constructor(...a) {
      super(...(a.length ? a : [ms]));
    }
    static now() {
      return ms;
    }
  };
  return {
    clock: new Date().toISOString(),
    viewport: [innerWidth, innerHeight],
    dpr: devicePixelRatio,
    zoom: visualViewport.scale,
  };
}
export async function patchProject(overrides) {
  const { appAtomRegistry: r } = await import("/src/rpc/atomRegistry.ts");
  const { serverEnvironment: e } = await import("/src/state/server.ts");
  const result = await e.updateSettings.run(r, {
    environmentId: "issue-6508-E1",
    input: { patch: { projectSettingsOverrides: overrides, projectSettingsFolded: false } },
  });
  return result;
}
export async function oracle() {
  const { useComposerDraftStore: s } = await import("/src/composerDraftStore.ts");
  const { appAtomRegistry: r } = await import("/src/rpc/atomRegistry.ts");
  const { environmentShell: e } = await import("/src/state/shell.ts");
  return {
    url: location.href,
    clock: new Date().toISOString(),
    dpr: devicePixelRatio,
    viewport: [innerWidth, innerHeight],
    theme: {
      id: document.documentElement.dataset.themeId,
      appearance: document.documentElement.dataset.themeAppearance,
    },
    local: localStorage.getItem("t3code:composer-drafts:v1"),
    sessions: s.getState().draftThreadsByThreadKey,
    composers: s.getState().draftsByThreadKey,
    shell: r.get(e.stateValueAtom("issue-6508-E1")),
  };
}
export function captureCommands() {
  if (globalThis.__issue6508Commands) return;
  globalThis.__issue6508Commands = [];
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    if (
      typeof data === "string" &&
      /orchestration\.launchThread|thread\.create|turn\.start/.test(data)
    ) {
      try {
        globalThis.__issue6508Commands.push(JSON.parse(data));
      } catch {}
    }
    return send.call(this, data);
  };
}
