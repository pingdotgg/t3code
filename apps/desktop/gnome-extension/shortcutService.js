import { CLIENT_NAMES } from "./captureService.js";

/** Shell owns the chord only while the requesting T3 connection is alive. */
export class ShortcutService {
  constructor({ getNameOwner, grab, ungrab, watch, unwatch, isAvailable, activate }) {
    Object.assign(this, { getNameOwner, grab, ungrab, watch, unwatch, isAvailable, activate });
    this.bindings = new Map();
    this.enabled = true;
  }

  async bind(sender, name, accelerator) {
    if (
      !CLIENT_NAMES.some((client) => `${client}.Shortcut` === name) ||
      (await this.getNameOwner(name)) !== sender
    )
      throw new Error("Only T3 Code may register a snapshot shortcut.");
    if (!this.enabled || !this.isAvailable())
      throw new Error("Snapshot shortcuts are unavailable in this session.");
    const previous = this.bindings.get(sender);
    if (previous?.accelerator === accelerator) return;
    const action = this.grab(accelerator);
    if (!action) throw new Error("This shortcut is already used by the system or another app.");
    const binding = { action, accelerator, watch: 0 };
    try {
      binding.watch = this.watch(sender, () => this.release(sender));
    } catch (error) {
      this.ungrab(action);
      throw error;
    }
    this.release(sender);
    this.bindings.set(sender, binding);
  }

  activated(action) {
    if (!this.enabled || !this.isAvailable()) return;
    for (const [sender, binding] of this.bindings) {
      if (binding.action === action) this.activate(sender);
    }
  }

  release(sender) {
    const binding = this.bindings.get(sender);
    if (!binding) return;
    this.bindings.delete(sender);
    this.ungrab(binding.action);
    if (binding.watch) this.unwatch(binding.watch);
  }

  disable() {
    this.enabled = false;
    for (const sender of this.bindings.keys()) this.release(sender);
  }
}
