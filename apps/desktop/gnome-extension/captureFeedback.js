import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Meta from "gi://Meta";
import St from "gi://St";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { captureDestinationFrame, findCaptureDestination } from "./feedbackGeometry.js";

/** A single, bounded, sender-owned flight. No live window clone or per-frame JS work. */
export class CaptureFeedback {
  begin(sender, pid, snapshot, options) {
    this.dispose();
    const session = { sender, pid };
    this._session = session;
    this._watch = Gio.bus_watch_name_on_connection(
      Gio.DBus.session,
      sender,
      Gio.BusNameWatcherFlags.NONE,
      null,
      () => {
        if (this._session === session) this.dispose();
      },
    );
    this._timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 6000, () => {
      this._timeout = 0;
      this.dispose();
      return GLib.SOURCE_REMOVE;
    });
    try {
      if (options.animate && snapshot.content && St.Settings.get().enable_animations) {
        this._actor = new Clutter.Actor({
          ...snapshot.bufferBounds,
          content: snapshot.content,
          reactive: false,
        });
        Main.uiGroup.add_child(this._actor);
      }
      if (options.flash) {
        this._flash = new St.Widget({
          ...snapshot.bounds,
          reactive: false,
          style: "background-color: white;",
          opacity: 24,
        });
        Main.uiGroup.add_child(this._flash);
        this._flash.ease({
          opacity: 0,
          duration: 180,
          mode: Clutter.AnimationMode.EASE_OUT_QUAD,
          onComplete: () => {
            this._flash?.destroy();
            this._flash = null;
          },
        });
      }
    } catch (error) {
      // Optional decoration must not prevent attaching a successfully captured image.
      this._clearActors();
      console.warn(`T3 capture effects unavailable: ${error.message}`);
    }
    return Boolean(this._actor);
  }

  _owned(sender) {
    if (
      !this._session ||
      this._session.sender !== sender ||
      Main.sessionMode.isLocked ||
      Main.sessionMode.isGreeter
    ) {
      throw new Error("No active capture belongs to this caller.");
    }
    return this._session;
  }

  async activate(sender, title) {
    const session = this._owned(sender);
    if (session.target) return;
    const find = () =>
      findCaptureDestination(
        global
          .get_window_actors()
          .map((actor) => actor.meta_window)
          .filter((window) => window.get_window_type() === Meta.WindowType.NORMAL),
        session.pid,
        title,
      );
    // A command-palette capture temporarily unmaps T3. Wait for its new surface, not a sleep.
    const target =
      find() ??
      (await new Promise((resolve) => {
        const check = () => {
          const window = find();
          if (window) finish(window);
        };
        let timeout;
        const mapped = global.window_manager.connect("map", check);
        const finish = (window) => {
          global.window_manager.disconnect(mapped);
          if (timeout) GLib.source_remove(timeout);
          this._cancelActivation = null;
          resolve(window);
        };
        this._cancelActivation = () => finish(undefined);
        timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
          timeout = 0;
          finish(undefined);
          return GLib.SOURCE_REMOVE;
        });
        check();
      }));
    if (this._owned(sender) !== session || !target)
      throw new Error("T3 Code's window is not available for activation.");
    session.target = target;
    Main.activateWindow(target, global.get_current_time());
  }

  async animate(sender, relative) {
    const session = this._owned(sender);
    if (this._flight) return this._flight;
    const actor = this._actor;
    if (!actor || !session.target || !St.Settings.get().enable_animations) {
      this._clearActors();
      return;
    }
    const window = session.target;
    const bounds = window.frame_rect_to_client_rect(window.get_frame_rect());
    const frame = captureDestinationFrame(relative, bounds);
    const distance = Math.hypot(frame.x - actor.x, frame.y - actor.y);
    this._flight = new Promise((resolve) => {
      this._land = resolve;
      actor.ease({
        x: frame.x,
        y: frame.y,
        scale_x: frame.width / actor.width,
        scale_y: frame.height / actor.height,
        duration: Math.round(680 - 400 * Math.exp(-distance / 2000)),
        mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        onStopped: () => {
          this._land?.();
          this._land = null;
        },
      });
    });
    await this._flight;
    // Keep the landed image until the renderer acknowledges the attachment (connection closes).
  }

  _clearActors() {
    this._actor?.destroy();
    this._flash?.destroy();
    this._actor = null;
    this._flash = null;
    this._land?.();
    this._land = null;
  }

  dispose() {
    this._session = null;
    this._cancelActivation?.();
    this._clearActors();
    this._flight = null;
    if (this._watch) Gio.bus_unwatch_name(this._watch);
    if (this._timeout) GLib.source_remove(this._timeout);
    this._watch = 0;
    this._timeout = 0;
  }
}
