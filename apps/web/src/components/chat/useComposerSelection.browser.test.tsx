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
function cursorThread(id: string) {
  return { environmentId, id: ThreadId.make(id), modelSelection: stored } as EnvironmentThreadShell;
}

function Picker(props: {
  thread: EnvironmentThreadShell;
  runtime: Parameters<typeof useComposerSelection>[0]["activeRuntime"];
}) {
  const { onProviderModelSelectStable } = useComposerSelection({
    environmentId,
    composerDraftTarget: scopeThreadRef(environmentId, props.thread.id),
    draftThread: null,
    activeThread: props.thread,
    activeRuntime: props.runtime,
    activeProjectSettings: { settings: { newWorktreesStartFromOrigin: false } },
    settings: DEFAULT_UNIFIED_SETTINGS,
    providerStatuses: providers,
    lockedProvider: null,
    supportsProviderSwitchingViaHandoff: true,
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

it("keeps a Cursor thread's stored model and options when the user re-picks its unavailable row", async () => {
  const thread = cursorThread("thread-cursor");
  await using _screen = await render(<Picker thread={thread} runtime={null} />);
  await page.getByRole("button", { name: "Pick the stored model" }).click();

  const draft = useComposerDraftStore
    .getState()
    .getComposerDraft(scopeThreadRef(environmentId, thread.id));
  expect(draft?.modelSelectionByProvider[cursor] ?? thread.modelSelection).toEqual(stored);
});

it("switches back to the thread's stored model while the session runs on another instance", async () => {
  const thread = cursorThread("thread-cursor-handoff");
  const runtime = { providerInstanceId: ProviderInstanceId.make("codex") } as Parameters<
    typeof useComposerSelection
  >[0]["activeRuntime"];
  await using _screen = await render(<Picker thread={thread} runtime={runtime} />);
  await page.getByRole("button", { name: "Pick the stored model" }).click();

  const draft = useComposerDraftStore
    .getState()
    .getComposerDraft(scopeThreadRef(environmentId, thread.id));
  expect(draft?.activeProvider).toBe(cursor);
});
