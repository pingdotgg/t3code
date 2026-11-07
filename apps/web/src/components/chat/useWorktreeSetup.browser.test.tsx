import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { useWorktreeSetup } from "./useWorktreeSetup";

vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: undefined }) }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../terminalUiStateStore", () => ({ useTerminalUiStateStore: () => vi.fn() }));
let renderer: Root | undefined;
let preparing: boolean | undefined;
function Probe({ environmentId }: { environmentId: EnvironmentId }) {
  // oxlint-disable-next-line t3code/no-manual-memo -- Exercise fresh caller inputs rather than compiler-stabilized references.
  "use no memo";
  // Fresh equivalent inputs must converge even without compiler memoization.
  const value = useWorktreeSetup({
    routeThreadRef: { environmentId, threadId: ThreadId.make("draft-thread") },
    ownerKey: "draft",
    activeThread: undefined,
    threadRef: null,
    serverProjection: null,
    activityRun: null,
    localPreparing: false,
    sendQueuesBehindSetup: false,
    followUpSent: false,
  });
  useLayoutEffect(() => {
    preparing = value.isPreparingWorktree;
  });
  return null;
}
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});
it("opens a draft with a newly allocated route ref on every render", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(() => {
    renderer = createRoot(document.createElement("div"));
    renderer.render(<Probe environmentId={EnvironmentId.make("local")} />);
  });
  expect(preparing).toBe(false);
  await act(() => renderer!.render(<Probe environmentId={EnvironmentId.make("remote")} />));
  expect(preparing).toBe(false);
});
