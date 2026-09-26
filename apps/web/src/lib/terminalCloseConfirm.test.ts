import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { confirmMock, readLocalApiMock } = vi.hoisted(() => {
  const confirmMock = vi.fn<(message: string, options?: unknown) => Promise<boolean>>();
  const readLocalApiMock = vi.fn<
    () =>
      | {
          dialogs: { confirm: (message: string, options?: unknown) => Promise<boolean> };
        }
      | undefined
  >();
  return { confirmMock, readLocalApiMock };
});

vi.mock("~/localApi", () => ({
  readLocalApi: () => readLocalApiMock(),
}));

import {
  confirmInspectedTerminalClose,
  confirmTerminalClose,
  isTerminalCloseConfirmPending,
} from "./terminalCloseConfirm";

describe("terminal close confirmation", () => {
  beforeEach(() => {
    confirmMock.mockReset();
    readLocalApiMock.mockReset();
    readLocalApiMock.mockReturnValue({ dialogs: { confirm: confirmMock } });
  });

  it("tracks pending state until the confirmation settles", async () => {
    let settle: (value: boolean) => void = () => undefined;
    confirmMock.mockImplementation(() => new Promise<boolean>((resolve) => (settle = resolve)));

    expect(isTerminalCloseConfirmPending()).toBe(false);

    const confirmation = confirmTerminalClose([{ label: "Terminal 1" }]);
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

    const confirmation = confirmTerminalClose([{ label: "Terminal 1" }]);
    expect(isTerminalCloseConfirmPending()).toBe(true);

    reject(new Error("dialog failed"));
    await expect(confirmation).resolves.toBe(false);
    expect(isTerminalCloseConfirmPending()).toBe(false);
  });

  it("names every terminal in a multi-terminal close", async () => {
    confirmMock.mockResolvedValue(true);

    await expect(
      confirmTerminalClose([{ label: "Terminal 1" }, { label: "Development server" }]),
    ).resolves.toBe(true);
    expect(confirmMock).toHaveBeenCalledWith(
      [
        "Close 2 terminals?",
        'This stops their running processes and clears their histories: "Terminal 1", "Development server".',
      ].join("\n"),
      { variant: "destructive" },
    );
  });

  it("closes known idle terminals without prompting", async () => {
    await expect(
      confirmTerminalClose([{ label: "Terminal 1", hasRunningSubprocess: false }]),
    ).resolves.toBe(true);
    await expect(
      confirmTerminalClose([
        { label: "Terminal 1", hasRunningSubprocess: false },
        { label: "Terminal 2", hasRunningSubprocess: false },
      ]),
    ).resolves.toBe(true);

    expect(confirmMock).not.toHaveBeenCalled();
    expect(isTerminalCloseConfirmPending()).toBe(false);
  });

  it("keeps prompting when a terminal is running or its activity is unknown", async () => {
    confirmMock.mockResolvedValue(true);

    await confirmTerminalClose([
      { label: "Terminal 1", hasRunningSubprocess: false },
      { label: "Development server", hasRunningSubprocess: true },
    ]);
    await confirmTerminalClose([{ label: "Terminal 1" }]);
    await confirmTerminalClose([
      { label: "Terminal 1", hasRunningSubprocess: false },
      { label: "Terminal 2" },
    ]);

    expect(confirmMock).toHaveBeenCalledTimes(3);
  });

  it("uses a fresh inspection and fails safe when inspection is unavailable", async () => {
    confirmMock.mockResolvedValue(true);
    const labelFor = (terminalId: string) => `Terminal ${terminalId}`;

    await expect(
      confirmInspectedTerminalClose({
        terminalIds: ["1"],
        labelFor,
        inspect: async () => [{ terminalId: "1", hasRunningSubprocess: false }],
      }),
    ).resolves.toBe(true);
    expect(confirmMock).not.toHaveBeenCalled();

    await confirmInspectedTerminalClose({
      terminalIds: ["1"],
      labelFor,
      inspect: async () => [{ terminalId: "1", hasRunningSubprocess: true }],
    });
    await confirmInspectedTerminalClose({
      terminalIds: ["1"],
      labelFor,
      inspect: async () => undefined,
    });
    await confirmInspectedTerminalClose({
      terminalIds: ["1"],
      labelFor,
      inspect: async () => [{ terminalId: "1", hasRunningSubprocess: null }],
    });

    expect(confirmMock).toHaveBeenCalledTimes(3);
  });

  it("closes without prompting when no local API is available", async () => {
    readLocalApiMock.mockReturnValue(undefined);

    await expect(confirmTerminalClose([{ label: "Terminal 1" }])).resolves.toBe(true);
    expect(confirmMock).not.toHaveBeenCalled();
  });
});
