// @effect-diagnostics nodeBuiltinImport:off -- Private D-Bus integration fixture.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import { Message, MessageType, NameFlag, sessionBus, type MessageBus } from "dbus-next";
import { expect, it, vi } from "vite-plus/test";
import { PortalCaptureShortcut } from "./PortalCaptureShortcut.ts";

it.runIf(NodeChildProcess.spawnSync("dbus-daemon", ["--version"]).status === 0)(
  "binds through the extension on a real bus without GlobalShortcuts and releases its identity on close",
  async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-gnome-shortcut-"));
    let daemon: NodeChildProcess.ChildProcess | undefined;
    let server: MessageBus | undefined;
    let client: PortalCaptureShortcut | undefined;
    try {
      vi.stubEnv("FLATPAK_ID", "");
      vi.stubEnv("SNAP", "");
      daemon = NodeChildProcess.spawn(
        "dbus-daemon",
        [
          "--session",
          "--nofork",
          "--nopidfile",
          "--print-address",
          `--address=unix:path=${NodePath.join(dir, "bus")}`,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const lines = NodeReadline.createInterface({ input: daemon.stdout! });
      const [address] = await Promise.race([
        NodeEvents.EventEmitter.once(lines, "line"),
        NodeEvents.EventEmitter.once(daemon, "exit").then(() => {
          throw new Error("Private bus failed to start");
        }),
      ]);
      lines.close();
      const connect = () => sessionBus({ busAddress: String(address) });
      server = connect();
      server.on("error", () => undefined);
      const gnome = "org.gnome.Shell.Extensions.T3SnapShot";
      const path = "/org/gnome/Shell/Extensions/T3SnapShot";
      const name = "com.t3tools.T3Code.SnapShot.Shortcut";
      await server.requestName("org.freedesktop.portal.Desktop", NameFlag.DO_NOT_QUEUE);
      await server.requestName(gnome, NameFlag.DO_NOT_QUEUE);
      await server.call(
        new Message({
          destination: "org.freedesktop.DBus",
          path: "/org/freedesktop/DBus",
          interface: "org.freedesktop.DBus",
          member: "AddMatch",
          signature: "s",
          body: [
            `type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='${name}'`,
          ],
        }),
      );
      const released = Promise.withResolvers<void>();
      let sender = "";
      server.on("message", (message: Message) => {
        if (
          message.type === MessageType.SIGNAL &&
          message.member === "NameOwnerChanged" &&
          message.body[0] === name &&
          message.body[1] === sender &&
          message.body[2] === ""
        )
          released.resolve();
      });
      server.addMethodHandler((message: Message) => {
        if (message.member === "Register") server!.send(Message.newMethodReturn(message));
        else if (["Get", "GetAll"].includes(message.member)) {
          const error = Message.newMethodReturn(message, "s", ["No such interface"]);
          error.type = MessageType.ERROR;
          error.errorName = "org.freedesktop.DBus.Error.InvalidArgs";
          server!.send(error);
        } else if (message.member === "BindShortcut" && message.path === path) {
          expect(message.body).toEqual([name, "<Control><Shift>w"]);
          sender = message.sender;
          server!.send(Message.newMethodReturn(message));
        } else return false;
        return true;
      });
      const received = Promise.withResolvers<void>();
      client = new PortalCaptureShortcut(
        "com.t3tools.T3Code",
        {
          key: "w",
          ctrlKey: true,
          modKey: false,
          shiftKey: true,
          altKey: false,
          metaKey: false,
        },
        () => received.resolve(),
        () => {},
        connect(),
        false,
        true,
      );
      await client.ready;
      expect(client.state.shortcutRegistered).toBe(true);
      const owner = await server.call(
        new Message({
          destination: "org.freedesktop.DBus",
          path: "/org/freedesktop/DBus",
          interface: "org.freedesktop.DBus",
          member: "GetNameOwner",
          signature: "s",
          body: [name],
        }),
      );
      expect(owner?.body[0]).toBe(sender);
      // The capture connection must still be able to acquire its independent identity.
      expect(await server.requestName("com.t3tools.T3Code.SnapShot", NameFlag.DO_NOT_QUEUE)).toBe(
        1,
      );
      const signal = Message.newSignal(path, gnome, "ShortcutActivated", "", []);
      signal.destination = sender;
      server.send(signal);
      await received.promise;
      client.close();
      await released.promise;
    } finally {
      client?.close();
      server?.disconnect();
      if (daemon && daemon.exitCode === null) {
        const exited = NodeEvents.EventEmitter.once(daemon, "exit");
        daemon.kill();
        await exited;
      }
      vi.unstubAllEnvs();
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  },
);
