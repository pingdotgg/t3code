// @effect-diagnostics globalTimers:off -- A plain Node child; the poll runs outside any Effect fiber.
import { SNAP_SHOT_MODIFIERS, type SnapShotModifier } from "@t3tools/contracts";

import { loadWindowsForegroundApi } from "../electron/WindowsForeground.ts";
import { WINDOWS_MODIFIER_PAIR_VIRTUAL_KEYS } from "./snapShot.ts";

const POLL_INTERVAL_MS = 50;

const requested = process.argv[2];
if (!(SNAP_SHOT_MODIFIERS as readonly string[]).includes(requested ?? "")) {
  process.exit(1);
}
const [left, right] = WINDOWS_MODIFIER_PAIR_VIRTUAL_KEYS[requested as SnapShotModifier];
const MODIFIER_VIRTUAL_KEYS = new Set([
  0x10,
  0x11,
  0x12,
  0xff,
  ...Object.values(WINDOWS_MODIFIER_PAIR_VIRTUAL_KEYS).flat(),
]);

const HWND_MESSAGE = -3n;
const RIDEV_INPUTSINK = 0x100;
const WM_INPUT = 0x00ff;
const PM_REMOVE = 1;
const RID_INPUT = 0x10000003;
const RIM_TYPEKEYBOARD = 1;
const RI_KEY_BREAK = 1;
// x64/arm64 layouts: MSG is 48 bytes (lParam at 24), RAWINPUTHEADER is 24, RAWKEYBOARD follows it.
const MSG_SIZE = 48;
const RAW_INPUT_HEADER_SIZE = 24;

// Raw Input queues every key event, so a keystroke between two polls is still seen.
async function openKeyboardActivity(): Promise<() => boolean> {
  const { DataType, load, open } = await import("ffi-rs");
  const library = "t3-user32-raw-input";
  open({ library, path: "user32.dll" });
  const className = Buffer.from("STATIC\0", "utf16le");
  const window = load({
    library,
    funcName: "CreateWindowExW",
    retType: DataType.BigInt,
    paramsType: [
      DataType.U32,
      DataType.U8Array,
      DataType.BigInt,
      DataType.U32,
      DataType.I32,
      DataType.I32,
      DataType.I32,
      DataType.I32,
      DataType.BigInt,
      DataType.BigInt,
      DataType.BigInt,
      DataType.BigInt,
    ],
    paramsValue: [0, className, 0n, 0, 0, 0, 0, 0, HWND_MESSAGE, 0n, 0n, 0n],
  }) as bigint;
  if (window === 0n) throw new Error("CreateWindowExW failed");
  const device = Buffer.alloc(16);
  device.writeUInt16LE(0x01, 0);
  device.writeUInt16LE(0x06, 2);
  device.writeUInt32LE(RIDEV_INPUTSINK, 4);
  device.writeBigUInt64LE(window, 8);
  const registered = load({
    library,
    funcName: "RegisterRawInputDevices",
    retType: DataType.Boolean,
    paramsType: [DataType.U8Array, DataType.U32, DataType.U32],
    paramsValue: [device, 1, device.byteLength],
  });
  if (!registered) throw new Error("RegisterRawInputDevices failed");

  const message = Buffer.alloc(MSG_SIZE);
  const input = Buffer.alloc(64);
  const inputSize = Buffer.alloc(4);
  return () => {
    let typed = false;
    while (
      load({
        library,
        funcName: "PeekMessageW",
        retType: DataType.Boolean,
        paramsType: [DataType.U8Array, DataType.BigInt, DataType.U32, DataType.U32, DataType.U32],
        paramsValue: [message, window, WM_INPUT, WM_INPUT, PM_REMOVE],
      })
    ) {
      inputSize.writeUInt32LE(input.byteLength, 0);
      const read = load({
        library,
        funcName: "GetRawInputData",
        retType: DataType.U32,
        paramsType: [
          DataType.BigInt,
          DataType.U32,
          DataType.U8Array,
          DataType.U8Array,
          DataType.U32,
        ],
        paramsValue: [
          message.readBigUInt64LE(24),
          RID_INPUT,
          input,
          inputSize,
          RAW_INPUT_HEADER_SIZE,
        ],
      });
      if (read === 0xffffffff || input.readUInt32LE(0) !== RIM_TYPEKEYBOARD) continue;
      const flags = input.readUInt16LE(RAW_INPUT_HEADER_SIZE + 2);
      const virtualKey = input.readUInt16LE(RAW_INPUT_HEADER_SIZE + 6);
      if ((flags & RI_KEY_BREAK) === 0 && !MODIFIER_VIRTUAL_KEYS.has(virtualKey)) typed = true;
    }
    return typed;
  };
}

async function poll() {
  const api = await loadWindowsForegroundApi();
  const drainTyping = await openKeyboardActivity();
  let active = false;
  // A key typed since the pair was last fully up means the overlap came from typing (rolled
  // Shifts for consecutive capitals), not a deliberate press, so it does not trigger.
  let typed = false;
  process.send?.("ready");
  const timer = setInterval(() => {
    if (drainTyping()) typed = true;
    const leftDown = api.isKeyDown(left);
    const rightDown = api.isKeyDown(right);
    const pressed = leftDown && rightDown;
    if (pressed && !active && !typed) {
      try {
        process.send?.("trigger");
      } catch {}
    }
    active = pressed;
    if (!leftDown && !rightDown) typed = false;
  }, POLL_INTERVAL_MS);
  const shutdown = () => {
    clearInterval(timer);
    process.exit(0);
  };
  process.once("disconnect", shutdown);
  process.once("SIGTERM", shutdown);
}

void poll().catch(() => process.exit(1));
