import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("../../state/queries", () => ({
  useComposerPathSearch: () => ({ entries: [], isPending: false }),
  useComposerPullRequestSearch: () => ({ entries: [], isPending: false, error: null }),
  useThreadSearch: () => undefined,
}));
vi.mock("../../state/use-composer-drafts", () => ({
  getComposerDraftSnapshot: vi.fn(),
  setComposerDraftContext: vi.fn(),
  useComposerDraftSelection: () => null,
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "context-id" }));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providersValueAtom: vi.fn(),
    refreshProviders: Symbol("refreshProviders"),
  },
}));

import { useComposerCommandMenu } from "./use-composer-command-menu";

it("/model clears only its trigger and opens the model picker", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const onChangeDraftMessage = vi.fn();
  const onOpenModelPicker = vi.fn();
  let menu: ReturnType<typeof useComposerCommandMenu> | undefined;
  function Probe() {
    menu = useComposerCommandMenu({
      draftMessage: "fix this /mod",
      ownerKey: "draft",
      environmentId: null,
      projectCwd: null,
      selectedProviderStatus: null,
      hasThread: true,
      onChangeDraftMessage,
      onOpenModelPicker,
    });
    return null;
  }

  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  const model = menu?.items.find((item) => item.id === "cmd:model");
  if (!model) throw new Error("Expected /model in the slash menu");
  await act(async () => menu?.onSelect(model));

  expect(onOpenModelPicker).toHaveBeenCalledOnce();
  expect(onChangeDraftMessage).toHaveBeenCalledWith("fix this ");
  act(() => root.unmount());
});
