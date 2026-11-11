import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const io = vi.hoisted(() => ({
  platform: vi.fn(() => "win32"),
  stat: vi.fn(() => ({ isCharacterDevice: (): boolean => true })),
  open: vi.fn(() => 42),
  close: vi.fn(),
  isatty: vi.fn((fd: number) => fd !== 0),
}));

vi.mock("node:fs", () => ({ fstatSync: io.stat, openSync: io.open, closeSync: io.close }));
vi.mock("node:tty", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    isatty: io.isatty,
    ReadStream: class extends EventEmitter {
      readonly isTTY = true;
      readonly _readableState = { reading: true };
      _handle: { reading: boolean; readStop: () => void } | undefined = {
        reading: true,
        readStop: vi.fn(),
      };
    },
  };
});
vi.mock("@t3tools/shared/HostProcess", () => ({ Platform: { defaultValue: io.platform } }));

const originalStdin = Object.getOwnPropertyDescriptor(process, "stdin")!;

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubEnv("T3CODE_DESKTOP_CLI_LAUNCHER", "1");
});

afterEach(() => {
  Object.defineProperty(process, "stdin", originalStdin);
  vi.unstubAllEnvs();
});

describe("attachConsoleStdin", () => {
  it("reopens the console when Node replaces missing Windows stdin with NUL", async () => {
    const { attachConsoleStdin, interactiveStdin } = await import("./consoleStdin.ts");

    expect(attachConsoleStdin()).toBe(42);
    expect(process.stdin.isTTY).toBe(true);
    expect(interactiveStdin()).toBe(42);
    expect(process.env.T3CODE_DESKTOP_CLI_LAUNCHER).toBeUndefined();
  });

  it("releases console reads when the picker pauses stdin before launching an agent", async () => {
    const { attachConsoleStdin, interactiveStdin } = await import("./consoleStdin.ts");
    attachConsoleStdin();
    const stdin = process.stdin as unknown as {
      emit(event: string): boolean;
      _readableState: { reading: boolean };
      _handle: { reading: boolean; readStop: () => void };
    };
    stdin.emit("pause");
    expect(stdin._readableState.reading).toBe(false);
    expect(stdin._handle.reading).toBe(false);
    expect(stdin._handle.readStop).toHaveBeenCalledOnce();
    expect(interactiveStdin()).toBe(42);
  });

  it("can pause after the reopened stream's handle has been closed", async () => {
    const { attachConsoleStdin } = await import("./consoleStdin.ts");
    attachConsoleStdin();
    const stdin = process.stdin as unknown as {
      emit(event: string): boolean;
      _handle: undefined;
    };
    stdin._handle = undefined;
    expect(() => stdin.emit("pause")).not.toThrow();
  });

  it("still reopens a closed stdin", async () => {
    io.stat.mockImplementation(() => {
      throw new Error("EBADF");
    });
    const { attachConsoleStdin, interactiveStdin } = await import("./consoleStdin.ts");
    expect(attachConsoleStdin()).toBe(42);
    expect(interactiveStdin()).toBe(42);
  });

  it.each(["pipe", "file"])("preserves redirected %s input", async () => {
    io.stat.mockReturnValue({ isCharacterDevice: () => false });
    const stdin = process.stdin;
    const { attachConsoleStdin, interactiveStdin } = await import("./consoleStdin.ts");
    expect(attachConsoleStdin()).toBeUndefined();
    expect(process.stdin).toBe(stdin);
    expect(interactiveStdin()).toBe("inherit");
    expect(io.open).not.toHaveBeenCalled();
  });

  it.each(["console input", "redirected output", "unmarked process", "non-Windows"])(
    "leaves %s alone",
    async (scenario) => {
      if (scenario === "console input") io.isatty.mockReturnValue(true);
      if (scenario === "redirected output") io.isatty.mockReturnValue(false);
      if (scenario === "unmarked process") delete process.env.T3CODE_DESKTOP_CLI_LAUNCHER;
      if (scenario === "non-Windows") io.platform.mockReturnValue("darwin");
      const { attachConsoleStdin, interactiveStdin } = await import("./consoleStdin.ts");
      expect(attachConsoleStdin()).toBeUndefined();
      expect(interactiveStdin()).toBe("inherit");
      expect(io.open).not.toHaveBeenCalled();
      expect(process.env.T3CODE_DESKTOP_CLI_LAUNCHER).toBeUndefined();
    },
  );

  it("keeps inherited input when CONIN$ cannot be opened", async () => {
    io.open.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const { attachConsoleStdin, interactiveStdin } = await import("./consoleStdin.ts");
    expect(attachConsoleStdin()).toBeUndefined();
    expect(interactiveStdin()).toBe("inherit");
  });

  it("closes a reopened descriptor that is not a console", async () => {
    io.isatty.mockImplementation((fd) => fd === 1);
    const { attachConsoleStdin, interactiveStdin } = await import("./consoleStdin.ts");
    expect(attachConsoleStdin()).toBeUndefined();
    expect(interactiveStdin()).toBe("inherit");
    expect(io.close).toHaveBeenCalledWith(42);
  });
});
