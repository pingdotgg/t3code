import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { confirmMock, readLocalApiMock, settingsMock } = vi.hoisted(() => {
  const confirmMock = vi.fn<(message: string, options?: unknown) => Promise<boolean>>();
  const readLocalApiMock = vi.fn<
    () =>
      | {
          dialogs: { confirm: (message: string, options?: unknown) => Promise<boolean> };
        }
      | undefined
  >();
  return { confirmMock, readLocalApiMock, settingsMock: { confirmTerminalClose: true } };
});

vi.mock("~/hooks/useSettings", () => ({ getClientSettings: () => settingsMock }));

vi.mock("~/localApi", () => ({
  readLocalApi: () => readLocalApiMock(),
}));

import { confirmTerminalClose, isTerminalCloseConfirmPending } from "./terminalCloseConfirm";

describe("terminal close confirmation", () => {
  beforeEach(() => {
    settingsMock.confirmTerminalClose = true;
    confirmMock.mockReset();
    readLocalApiMock.mockReset();
    readLocalApiMock.mockReturnValue({ dialogs: { confirm: confirmMock } });
  });

  it("closes single and multiple terminals immediately when confirmation is disabled", async () => {
    settingsMock.confirmTerminalClose = false;

    await expect(confirmTerminalClose(["Terminal 1"])).resolves.toBe(true);
    await expect(confirmTerminalClose(["Terminal 1", "Terminal 2"])).resolves.toBe(true);
    expect(confirmMock).not.toHaveBeenCalled();
    expect(isTerminalCloseConfirmPending()).toBe(false);

    settingsMock.confirmTerminalClose = true;
    confirmMock.mockResolvedValue(false);
    await expect(confirmTerminalClose(["Terminal 1"])).resolves.toBe(false);
    expect(confirmMock).toHaveBeenCalledOnce();
  });

  it("clears pending state and resolves false when the dialog rejects", async () => {
    let reject: (reason?: unknown) => void = () => undefined;
    confirmMock.mockImplementation(
      () =>
        new Promise<boolean>((_resolve, rejectPromise) => {
          reject = rejectPromise;
        }),
    );

    const confirmation = confirmTerminalClose(["Terminal 1"]);
    expect(isTerminalCloseConfirmPending()).toBe(true);

    reject(new Error("dialog failed"));
    await expect(confirmation).resolves.toBe(false);
    expect(isTerminalCloseConfirmPending()).toBe(false);
  });
});
