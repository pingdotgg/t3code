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
  ...Object.values(WINDOWS_MODIFIER_PAIR_VIRTUAL_KEYS).flat(),
]);
const TYPING_VIRTUAL_KEYS = Array.from({ length: 0xfe - 0x08 + 1 }, (_, i) => i + 0x08).filter(
  (key) => !MODIFIER_VIRTUAL_KEYS.has(key),
);

async function poll() {
  const api = await loadWindowsForegroundApi();
  let active = false;
  // A key typed while either key of the pair was held means the overlap came from typing (rolled
  // Shifts for consecutive capitals), not a deliberate press, so it does not trigger.
  let typed = false;
  process.send?.("ready");
  const timer = setInterval(() => {
    const leftDown = api.isKeyDown(left);
    const rightDown = api.isKeyDown(right);
    const pressed = leftDown && rightDown;
    if (!leftDown && !rightDown) typed = false;
    else if (!typed) typed = TYPING_VIRTUAL_KEYS.some((key) => api.isKeyDown(key));
    if (pressed && !active && !typed) {
      try {
        process.send?.("trigger");
      } catch {}
    }
    active = pressed;
  }, POLL_INTERVAL_MS);
  const shutdown = () => {
    clearInterval(timer);
    process.exit(0);
  };
  process.once("disconnect", shutdown);
  process.once("SIGTERM", shutdown);
}

void poll().catch(() => process.exit(1));
