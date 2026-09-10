export interface WindowsForegroundApi {
  readonly getCurrentThreadId: () => number;
  readonly getForegroundWindow: () => bigint;
  readonly getWindowClassName: (windowHandle: bigint) => string;
  readonly getWindowThreadId: (windowHandle: bigint) => number;
  readonly getWindowThreadAndProcessId: (windowHandle: bigint) => {
    readonly threadId: number;
    readonly processId: number;
  };
  readonly getWindowText: (windowHandle: bigint) => string;
  readonly getWindowRect: (
    windowHandle: bigint,
  ) =>
    | { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
    | undefined;
  readonly getProcessImagePath: (processId: number) => string;
  /** High bit of `GetAsyncKeyState`: whether the virtual key is currently down. */
  readonly isKeyDown: (virtualKey: number) => boolean;
  readonly attachThreadInput: (
    sourceThreadId: number,
    targetThreadId: number,
    attach: boolean,
  ) => boolean;
  readonly setForegroundWindow: (windowHandle: bigint) => boolean;
}

const WINDOWS_SHELL_HOSTED_WINDOW_CLASSES = new Set(["ApplicationFrameWindow"]);

function nativeWindowHandle(buffer: Buffer): bigint {
  if (buffer.length === 8) return buffer.readBigUInt64LE();
  if (buffer.length === 4) return BigInt(buffer.readUInt32LE());
  throw new Error(`Unsupported Windows window handle size: ${String(buffer.length)} bytes.`);
}

export function activateWindowsForegroundWithApi(
  handleBuffer: Buffer,
  api: WindowsForegroundApi,
): boolean {
  const targetWindow = nativeWindowHandle(handleBuffer);
  const foregroundWindow = api.getForegroundWindow();
  if (targetWindow === foregroundWindow) return true;

  const currentThreadId = api.getCurrentThreadId();
  const foregroundThreadId = foregroundWindow === 0n ? 0 : api.getWindowThreadId(foregroundWindow);
  const shouldAttach =
    currentThreadId !== 0 && foregroundThreadId !== 0 && currentThreadId !== foregroundThreadId;
  const attached = shouldAttach && api.attachThreadInput(currentThreadId, foregroundThreadId, true);

  try {
    return api.setForegroundWindow(targetWindow);
  } finally {
    if (attached) {
      api.attachThreadInput(currentThreadId, foregroundThreadId, false);
    }
  }
}

export function isWindowsShellHostedForegroundWithApi(api: WindowsForegroundApi): boolean {
  const foregroundWindow = api.getForegroundWindow();
  return (
    foregroundWindow !== 0n &&
    WINDOWS_SHELL_HOSTED_WINDOW_CLASSES.has(api.getWindowClassName(foregroundWindow))
  );
}

let windowsForegroundApiPromise: Promise<WindowsForegroundApi> | undefined;

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

export function loadWindowsForegroundApi(): Promise<WindowsForegroundApi> {
  windowsForegroundApiPromise ??= import("ffi-rs").then(({ DataType, load, open }) => {
    const kernel32 = "t3-kernel32";
    const user32 = "t3-user32";
    open({ library: kernel32, path: "kernel32.dll" });
    open({ library: user32, path: "user32.dll" });

    return {
      getCurrentThreadId: () =>
        load({
          library: kernel32,
          funcName: "GetCurrentThreadId",
          retType: DataType.U32,
          paramsType: [],
          paramsValue: [],
        }),
      getForegroundWindow: () =>
        load({
          library: user32,
          funcName: "GetForegroundWindow",
          retType: DataType.BigInt,
          paramsType: [],
          paramsValue: [],
        }) as bigint,
      getWindowClassName: (windowHandle) => {
        const buffer = Buffer.alloc(512);
        const length = load({
          library: user32,
          funcName: "GetClassNameW",
          retType: DataType.I32,
          paramsType: [DataType.BigInt, DataType.U8Array, DataType.I32],
          paramsValue: [windowHandle, buffer, buffer.byteLength / 2],
        });
        return length > 0 ? buffer.subarray(0, length * 2).toString("utf16le") : "";
      },
      getWindowThreadId: (windowHandle) =>
        load({
          library: user32,
          funcName: "GetWindowThreadProcessId",
          retType: DataType.U32,
          paramsType: [DataType.BigInt, DataType.BigInt],
          paramsValue: [windowHandle, 0n],
        }),
      getWindowThreadAndProcessId: (windowHandle) => {
        const out = Buffer.alloc(4);
        const threadId = load({
          library: user32,
          funcName: "GetWindowThreadProcessId",
          retType: DataType.U32,
          paramsType: [DataType.BigInt, DataType.U8Array],
          paramsValue: [windowHandle, out],
        });
        return { threadId, processId: out.readUInt32LE(0) };
      },
      getWindowText: (windowHandle) => {
        const buffer = Buffer.alloc(2 * 1024);
        const length = load({
          library: user32,
          funcName: "GetWindowTextW",
          retType: DataType.I32,
          paramsType: [DataType.BigInt, DataType.U8Array, DataType.I32],
          paramsValue: [windowHandle, buffer, buffer.byteLength / 2],
        });
        return length > 0 ? buffer.subarray(0, length * 2).toString("utf16le") : "";
      },
      getWindowRect: (windowHandle) => {
        const rect = Buffer.alloc(16);
        const ok = load({
          library: user32,
          funcName: "GetWindowRect",
          retType: DataType.Boolean,
          paramsType: [DataType.BigInt, DataType.U8Array],
          paramsValue: [windowHandle, rect],
        });
        if (!ok) return undefined;
        const left = rect.readInt32LE(0);
        const top = rect.readInt32LE(4);
        return {
          x: left,
          y: top,
          width: Math.max(0, rect.readInt32LE(8) - left),
          height: Math.max(0, rect.readInt32LE(12) - top),
        };
      },
      getProcessImagePath: (processId) => {
        const handle = load({
          library: kernel32,
          funcName: "OpenProcess",
          retType: DataType.BigInt,
          paramsType: [DataType.U32, DataType.Boolean, DataType.U32],
          paramsValue: [PROCESS_QUERY_LIMITED_INFORMATION, false, processId],
        }) as bigint;
        if (handle === 0n) return "";
        try {
          const buffer = Buffer.alloc(2 * 32_768);
          const size = Buffer.alloc(4);
          size.writeUInt32LE(buffer.byteLength / 2, 0);
          const ok = load({
            library: kernel32,
            funcName: "QueryFullProcessImageNameW",
            retType: DataType.Boolean,
            paramsType: [DataType.BigInt, DataType.U32, DataType.U8Array, DataType.U8Array],
            paramsValue: [handle, 0, buffer, size],
          });
          return ok ? buffer.subarray(0, size.readUInt32LE(0) * 2).toString("utf16le") : "";
        } finally {
          load({
            library: kernel32,
            funcName: "CloseHandle",
            retType: DataType.Boolean,
            paramsType: [DataType.BigInt],
            paramsValue: [handle],
          });
        }
      },
      isKeyDown: (virtualKey) =>
        (load({
          library: user32,
          funcName: "GetAsyncKeyState",
          retType: DataType.I16,
          paramsType: [DataType.I32],
          paramsValue: [virtualKey],
        }) &
          0x8000) !==
        0,
      attachThreadInput: (sourceThreadId, targetThreadId, attach) =>
        load({
          library: user32,
          funcName: "AttachThreadInput",
          retType: DataType.Boolean,
          paramsType: [DataType.U32, DataType.U32, DataType.Boolean],
          paramsValue: [sourceThreadId, targetThreadId, attach],
        }),
      setForegroundWindow: (windowHandle) =>
        load({
          library: user32,
          funcName: "SetForegroundWindow",
          retType: DataType.Boolean,
          paramsType: [DataType.BigInt],
          paramsValue: [windowHandle],
        }),
    } satisfies WindowsForegroundApi;
  });
  return windowsForegroundApiPromise;
}

export async function activateWindowsForeground(handleBuffer: Buffer): Promise<void> {
  const api = await loadWindowsForegroundApi();
  if (activateWindowsForegroundWithApi(handleBuffer, api)) return;
  throw new Error("Windows refused to activate the T3 Code window.");
}

export async function isWindowsShellHostedForeground(): Promise<boolean> {
  return isWindowsShellHostedForegroundWithApi(await loadWindowsForegroundApi());
}
