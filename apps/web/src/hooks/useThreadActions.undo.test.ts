import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { useThreadActions } from "./useThreadActions";
import { threadEnvironment } from "../state/threads";
import { toastManager } from "../components/ui/toast";

const commands = vi.hoisted(() => ({ pin: vi.fn(), unpin: vi.fn() }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useCallback: (callback: unknown) => callback,
  useMemo: (create: () => unknown) => create(),
  useRef: (value: unknown) => ({ current: value }),
}));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({}) }));
vi.mock("./useSettings", () => ({ useClientSettings: () => false }));
vi.mock("./useHandleNewThread", () => ({ useNewThreadHandler: () => vi.fn() }));
vi.mock("../composerDraftStore", () => ({ useComposerDraftStore: () => vi.fn() }));
vi.mock("../terminalUiStateStore", () => ({ useTerminalUiStateStore: () => vi.fn() }));
vi.mock("../uiStateStore", () => ({ useUiStateStore: () => vi.fn() }));
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  readEnvironmentSupportsPinning: () => true,
  readEnvironmentSupportsPinReorder: () => true,
  readThreadShell: () => ({ title: "Thread", pinOrderKey: "a0" }),
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === threadEnvironment.pin
      ? commands.pin
      : command === threadEnvironment.unpin
        ? commands.unpin
        : vi.fn(),
}));

afterEach(() => vi.restoreAllMocks());

describe("unpin Undo", () => {
  it("ignores an old toast across hook instances and still restores the latest unpin", async () => {
    commands.pin.mockResolvedValue({ _tag: "Success", value: undefined });
    commands.unpin.mockResolvedValue({ _tag: "Success", value: undefined });
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    vi.spyOn(toastManager, "close").mockImplementation(() => {});
    const sidebar = useThreadActions();
    const header = useThreadActions();
    const target = {
      environmentId: EnvironmentId.make("undo-env"),
      threadId: ThreadId.make("thread"),
    };
    await sidebar.unpinThread(target);
    const staleUndo = add.mock.calls[0]?.[0].actionProps?.onClick;
    await header.pinThread(target, { orderKey: "a1" });
    await header.unpinThread(target);
    const latestUndo = add.mock.calls[1]?.[0].actionProps?.onClick;
    expect(staleUndo).toBeTypeOf("function");
    expect(latestUndo).toBeTypeOf("function");
    const event = {} as Parameters<NonNullable<typeof staleUndo>>[0];
    staleUndo?.(event);
    expect(commands.pin).toHaveBeenCalledTimes(1);
    latestUndo?.(event);
    expect(commands.pin).toHaveBeenCalledTimes(2);
    expect(commands.pin).toHaveBeenLastCalledWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, orderKey: "a0" },
    });
    latestUndo?.(event);
    expect(commands.pin).toHaveBeenCalledTimes(2);
  });
});
