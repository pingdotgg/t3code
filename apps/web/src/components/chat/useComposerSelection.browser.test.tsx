import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useComposerSelection } from "./useComposerSelection";

const environmentId = EnvironmentId.make("environment-local");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread-cursor"));
const cursor = ProviderInstanceId.make("cursor");
const stored = createModelSelection(cursor, "claude-opus-5-5", [{ id: "effort", value: "medium" }]);

const providers: ReadonlyArray<ServerProvider> = [
  {
    instanceId: cursor,
    driver: ProviderDriverKind.make("cursor"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [{ slug: "auto-smart", name: "Auto", isCustom: false, capabilities: {} }],
    slashCommands: [],
    skills: [],
  },
];

// The hook reads only the thread's identity and stored selection.
const activeThread = {
  environmentId,
  id: threadRef.threadId,
  modelSelection: stored,
} as EnvironmentThreadShell;

function Picker() {
  const { onProviderModelSelectStable } = useComposerSelection({
    environmentId,
    composerDraftTarget: threadRef,
    draftThread: null,
    activeThread,
    activeRuntime: null,
    activeProjectSettings: { settings: { newWorktreesStartFromOrigin: false } },
    settings: DEFAULT_UNIFIED_SETTINGS,
    providerStatuses: providers,
    lockedProvider: null,
    supportsProviderSwitchingViaHandoff: false,
    multipleModelSelections: null,
    runtimeMode: "full-access",
    interactionMode: "default",
    interactionModeEnabled: true,
    isLocalDraftThread: false,
    canOverrideServerThreadEnvMode: false,
    setPendingServerThreadEnvModeEntry: () => {},
    setPendingServerThreadStartFromOriginByThreadId: () => {},
    scheduleComposerFocus: () => {},
  });
  return (
    <button type="button" onClick={() => onProviderModelSelectStable(cursor, stored.model)}>
      Pick the stored model
    </button>
  );
}

it("keeps a Cursor thread's stored model when the user re-picks its unavailable row", async () => {
  await using _screen = await render(<Picker />);
  await page.getByRole("button", { name: "Pick the stored model" }).click();

  expect(
    useComposerDraftStore.getState().getComposerDraft(threadRef)?.modelSelectionByProvider[cursor]
      ?.model,
  ).toBe("claude-opus-5-5");
});
