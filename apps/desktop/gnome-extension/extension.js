import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Meta from "gi://Meta";
import Shell from "gi://Shell";
import St from "gi://St";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { CaptureService, isWaylandSession } from "./captureService.js";
import { CaptureFeedback } from "./captureFeedback.js";

const NAME = "org.gnome.Shell.Extensions.T3SnapShot";
const PATH = "/org/gnome/Shell/Extensions/T3SnapShot";
const XML = `<node><interface name="${NAME}">
  <property name="Version" type="u" access="read"/>
  <method name="Capture">
    <arg name="png" type="ay" direction="out"/>
    <arg name="metadata" type="s" direction="out"/>
  </method>
  <method name="CaptureWithFeedback">
    <arg name="flash" type="b" direction="in"/>
    <arg name="animate" type="b" direction="in"/>
    <arg name="png" type="ay" direction="out"/>
    <arg name="metadata" type="s" direction="out"/>
    <arg name="animationStarted" type="b" direction="out"/>
  </method>
  <method name="Activate"><arg name="title" type="s" direction="in"/></method>
  <method name="Animate">
    <arg name="x" type="d" direction="in"/>
    <arg name="y" type="d" direction="in"/>
    <arg name="width" type="d" direction="in"/>
    <arg name="height" type="d" direction="in"/>
  </method>
</interface></node>`;

function busIdentity(method, name, resultType) {
  return new Promise((resolve, reject) => {
    Gio.DBus.session.call(
      "org.freedesktop.DBus",
      "/org/freedesktop/DBus",
      "org.freedesktop.DBus",
      method,
      new GLib.Variant("(s)", [name]),
      new GLib.VariantType(resultType),
      Gio.DBusCallFlags.NONE,
      5_000,
      null,
      (connection, result) => {
        try {
          resolve(connection.call_finish(result).deepUnpack()[0]);
        } catch (error) {
          if (error.matches(Gio.DBusError, Gio.DBusError.NAME_HAS_NO_OWNER)) resolve(null);
          else reject(error);
        }
      },
    );
  });
}

const getNameOwner = (name) => busIdentity("GetNameOwner", name, "(s)");
const getProcessId = (sender) => busIdentity("GetConnectionUnixProcessID", sender, "(u)");

function takeSnapshot(animate) {
  // No await between reading identity and Shell taking its snapshot of the focused actor.
  const window = global.display.focus_window;
  if (!window || window.minimized || !window.get_compositor_private()) {
    throw new Error("No active window is available for capture.");
  }
  const app = Shell.WindowTracker.get_default().get_window_app(window);
  const bounds = window.get_frame_rect();
  const bufferBounds = window.get_buffer_rect();
  let content;
  if (animate && St.Settings.get().enable_animations) {
    try {
      content = window.get_compositor_private().paint_to_content(null);
    } catch (error) {
      console.warn(`T3 capture preview unavailable: ${error.message}`);
    }
  }
  const metadata = JSON.stringify({
    title: window.get_title() ?? "",
    appName: app?.get_name() ?? "",
    appIdentifier: app?.get_id() ?? "",
    processId: Math.max(0, window.get_pid()),
    bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
  });
  const stream = Gio.MemoryOutputStream.new_resizable();
  const screenshot = new Shell.Screenshot();
  return new Promise((resolve, reject) => {
    screenshot.screenshot_window(true, false, stream, (source, result) => {
      try {
        const [success] = source.screenshot_window_finish(result);
        if (!success) throw new Error("GNOME could not capture the active window.");
        stream.close(null);
        if (stream.get_data_size() > 32 * 1024 * 1024)
          throw new Error("The screenshot is too large.");
        resolve({
          png: stream.steal_as_bytes().get_data(),
          metadata,
          content,
          bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
          bufferBounds: {
            x: bufferBounds.x,
            y: bufferBounds.y,
            width: bufferBounds.width,
            height: bufferBounds.height,
          },
        });
      } catch (error) {
        reject(error);
      } finally {
        if (!stream.is_closed()) stream.close(null);
      }
    });
  });
}

export default class T3SnapShotExtension extends Extension {
  enable() {
    this._feedback = new CaptureFeedback();
    this._sessionChanged = Main.sessionMode.connect("updated", () => this._feedback.dispose());
    this._monitorsChanged = Main.layoutManager.connect("monitors-changed", () =>
      this._feedback.dispose(),
    );
    this._service = new CaptureService({
      getNameOwner,
      getProcessId,
      beginFeedback: (...args) => this._feedback.begin(...args),
      isAvailable: () =>
        isWaylandSession(Meta) && !Main.sessionMode.isLocked && !Main.sessionMode.isGreeter,
      takeSnapshot,
    });
    this._object = Gio.DBusExportedObject.wrapJSObject(XML, this);
    this._object.export(Gio.DBus.session, PATH);
    this._owner = Gio.bus_own_name_on_connection(
      Gio.DBus.session,
      NAME,
      Gio.BusNameOwnerFlags.NONE,
      null,
      null,
    );
  }

  get Version() {
    return 2;
  }

  CaptureAsync(_params, invocation) {
    void this._service
      .capture(invocation.get_sender())
      .then(({ png, metadata }) =>
        invocation.return_value(new GLib.Variant("(ays)", [png, metadata])),
      )
      .catch((error) => invocation.return_dbus_error(`${NAME}.Failed`, error.message));
  }

  CaptureWithFeedbackAsync([flash, animate], invocation) {
    void this._service
      .capture(invocation.get_sender(), { flash, animate })
      .then(({ png, metadata, animationStarted }) =>
        invocation.return_value(new GLib.Variant("(aysb)", [png, metadata, animationStarted])),
      )
      .catch((error) => invocation.return_dbus_error(`${NAME}.Failed`, error.message));
  }

  ActivateAsync([title], invocation) {
    void this._feedback
      .activate(invocation.get_sender(), title)
      .then(() => invocation.return_value(null))
      .catch((error) => invocation.return_dbus_error(`${NAME}.Failed`, error.message));
  }

  AnimateAsync([x, y, width, height], invocation) {
    void this._feedback
      .animate(invocation.get_sender(), { x, y, width, height })
      .then(() => invocation.return_value(null))
      .catch((error) => invocation.return_dbus_error(`${NAME}.Failed`, error.message));
  }

  disable() {
    this._service?.disable();
    this._feedback?.dispose();
    if (this._sessionChanged) Main.sessionMode.disconnect(this._sessionChanged);
    if (this._monitorsChanged) Main.layoutManager.disconnect(this._monitorsChanged);
    this._sessionChanged = 0;
    this._monitorsChanged = 0;
    this._object?.unexport();
    if (this._owner) Gio.bus_unown_name(this._owner);
    this._service = null;
    this._object = null;
    this._owner = null;
  }
}
