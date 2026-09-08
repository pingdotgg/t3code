// @effect-diagnostics globalTimers:off -- A plain Node child; the poll runs outside any Effect fiber.
// Windows modifier-pair listener. Runs in a forked Node-mode child so a stuck or
// crashed FFI call cannot take the main process with it. Mirrors the macOS
// poller: sample both physical keys at 20 Hz, fire on the rising edge.
import { SNAP_SHOT_MODIFIERS, type SnapShotModifier } from "@t3tools/contracts";

import { loadWindowsForegroundApi } from "../electron/WindowsForeground.ts";
import { WINDOWS_MODIFIER_PAIR_VIRTUAL_KEYS } from "./snapShot.ts";

const POLL_INTERVAL_MS = 50;

const requested = process.argv[2];
if (!(SNAP_SHOT_MODIFIERS as readonly string[]).includes(requested ?? "")) {
  process.exit(1);
}
const [left, right] = WINDOWS_MODIFIER_PAIR_VIRTUAL_KEYS[requested as SnapShotModifier];

async function poll() {
  const api = await loadWindowsForegroundApi();
  let active = false;
  process.send?.("ready");
  const timer = setInterval(() => {
    const pressed = api.isKeyDown(left) && api.isKeyDown(right);
    if (pressed && !active) {
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
