import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { confirmMock, readLocalApiMock, clientSettingsMock, persistClientSettingsPatchMock } =
  vi.hoisted(() => {
    const confirmMock = vi.fn<(message: string, options?: unknown) => Promise<boolean>>();
    const readLocalApiMock = vi.fn<
      () =>
        | {
            dialogs: { confirm: (message: string, options?: unknown) => Promise<boolean> };
          }
        | undefined
    >();
    const clientSettingsMock = { confirmTerminalClose: true };
    const persistClientSettingsPatchMock = vi.fn<(patch: unknown) => Promise<void>>();
    return {
      confirmMock,
      readLocalApiMock,
      clientSettingsMock,
      persistClientSettingsPatchMock,
    };
  });

vi.mock("~/localApi", () => ({
  readLocalApi: () => readLocalApiMock(),
}));

vi.mock("~/hooks/useSettings", () => ({
  getClientSettings: () => clientSettingsMock,
  persistClientSettingsPatch: (patch: unknown) => persistClientSettingsPatchMock(patch),
}));

import { confirmTerminalClose, isTerminalCloseConfirmPending } from "./terminalCloseConfirm";

describe("terminal close confirmation", () => {
  beforeEach(() => {
    confirmMock.mockReset();
    readLocalApiMock.mockReset();
    readLocalApiMock.mockReturnValue({ dialogs: { confirm: confirmMock } });
    clientSettingsMock.confirmTerminalClose = true;
    persistClientSettingsPatchMock.mockReset();
  });

  it("tracks pending state until the confirmation settles", async () => {
    let settle: (value: boolean) => void = () => undefined;
    confirmMock.mockImplementation(() => new Promise<boolean>((resolve) => (settle = resolve)));

    expect(isTerminalCloseConfirmPending()).toBe(false);

    const confirmation = confirmTerminalClose(["Terminal 1"]);
    expect(isTerminalCloseConfirmPending()).toBe(true);

    settle(true);
    await expect(confirmation).resolves.toBe(true);
    expect(isTerminalCloseConfirmPending()).toBe(false);
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

  it("names every terminal in a multi-terminal close", async () => {
    confirmMock.mockResolvedValue(true);

    await expect(confirmTerminalClose(["Terminal 1", "Development server"])).resolves.toBe(true);
    expect(confirmMock).toHaveBeenCalledWith(
      [
        "Close 2 terminals?",
        'This stops their running processes and clears their histories: "Terminal 1", "Development server".',
      ].join("\n"),
      {
        variant: "destructive",
        checkbox: expect.objectContaining({
          label: "Don't ask again",
        }),
      },
    );
  });

  it("closes without prompting when no local API is available", async () => {
    readLocalApiMock.mockReturnValue(undefined);

    await expect(confirmTerminalClose(["Terminal 1"])).resolves.toBe(true);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("closes without prompting when confirmTerminalClose is disabled in settings", async () => {
    clientSettingsMock.confirmTerminalClose = false;

    await expect(confirmTerminalClose(["Terminal 1"])).resolves.toBe(true);
    expect(confirmMock).not.toHaveBeenCalled();
    expect(isTerminalCloseConfirmPending()).toBe(false);
  });

  it("persists confirmTerminalClose: false when confirmed with checkbox checked", async () => {
    confirmMock.mockImplementation(async (_msg, options: any) => {
      options.checkbox?.onCheckedChange?.(true);
      return true;
    });

    await expect(confirmTerminalClose(["Terminal 1"])).resolves.toBe(true);
    expect(persistClientSettingsPatchMock).toHaveBeenCalledWith({
      confirmTerminalClose: false,
    });
  });

  it("does not persist settings when cancelled even if checkbox was checked", async () => {
    confirmMock.mockImplementation(async (_msg, options: any) => {
      options.checkbox?.onCheckedChange?.(true);
      return false;
    });

    await expect(confirmTerminalClose(["Terminal 1"])).resolves.toBe(false);
    expect(persistClientSettingsPatchMock).not.toHaveBeenCalled();
  });
});
