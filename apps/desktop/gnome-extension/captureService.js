export const CLIENT_NAMES = ["dev.ryoku.Hyakki.SnapShot", "dev.ryoku.Hyakki.Development.SnapShot"];

export function isWaylandSession(meta) {
  // GNOME 50 removed the X11 compositor and this API. GNOME 45–49 still need the check.
  return typeof meta.is_wayland_compositor !== "function" || meta.is_wayland_compositor();
}

export class CaptureService {
  constructor({ getNameOwner, isAvailable, takeSnapshot, getProcessId, beginFeedback }) {
    this._getNameOwner = getNameOwner;
    this._isAvailable = isAvailable;
    this._takeSnapshot = takeSnapshot;
    this._getProcessId = getProcessId;
    this._beginFeedback = beginFeedback;
    this._enabled = true;
    this._busy = false;
  }

  disable() {
    this._enabled = false;
  }

  _checkSession() {
    if (!this._enabled || !this._isAvailable()) {
      throw new Error("SnapShots are unavailable in this session.");
    }
  }

  async capture(sender, options) {
    this._checkSession();
    if (this._busy) throw new Error("A snapshot is already in progress.");
    this._busy = true;
    try {
      let allowed = false;
      for (const name of CLIENT_NAMES) {
        const owner = await this._getNameOwner(name);
        if (owner === sender) {
          allowed = true;
          break;
        }
      }
      if (!allowed) throw new Error("Only Hyakki may request a snapshot.");
      const pid = options ? await this._getProcessId(sender) : undefined;
      this._checkSession();
      const snapshot = await this._takeSnapshot(options?.animate ?? false);
      // Never deliver pixels after locking the session or disabling the extension.
      this._checkSession();
      if (options) {
        return {
          ...snapshot,
          animationStarted: this._beginFeedback(sender, pid, snapshot, options),
        };
      }
      return snapshot;
    } finally {
      this._busy = false;
    }
  }
}
