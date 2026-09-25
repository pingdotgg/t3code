// @effect-diagnostics nodeBuiltinImport:off -- Private D-Bus integration fixture, never the user's session bus.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import { Message, NameFlag, Variant, sessionBus, type MessageBus } from "dbus-next";
import { expect, it, vi } from "vite-plus/test";
import { PortalCaptureShortcut } from "./PortalCaptureShortcut.ts";

it.runIf(NodeChildProcess.spawnSync("dbus-daemon", ["--version"]).status === 0)(
  "registers, rebinds saved keys, receives activations, and replaces sessions over real D-Bus",
  async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-shortcut-dbus-"));
    let daemon: NodeChildProcess.ChildProcess | undefined;
    let server: MessageBus | undefined;
    const clients: PortalCaptureShortcut[] = [];
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
      await server.requestName("org.freedesktop.portal.Desktop", NameFlag.DO_NOT_QUEUE);
      const root = "/org/freedesktop/portal/desktop";
      const iface = "org.freedesktop.portal.GlobalShortcuts";
      const sessions = new Map<string, string>();
      const bindings = new Map<string, string>();
      const identities = new Set<string>();
      const closed = new Set<string>();
      const closeWaiters = new Map<string, () => void>();
      let bindCount = 0;
      server.addMethodHandler((message: Message) => {
        if (message.member === "Register") {
          expect(message.body[0]).toBe("com.t3tools.T3Code");
          identities.add(message.sender);
          server!.send(Message.newMethodReturn(message));
        } else if (message.member === "Get") {
          server!.send(Message.newMethodReturn(message, "v", [new Variant("u", 2)]));
        } else if (message.member === "Close") {
          closed.add(message.path);
          closeWaiters.get(message.path)?.();
        } else if (["CreateSession", "BindShortcuts"].includes(message.member)) {
          expect(identities.has(message.sender)).toBe(true);
          const options = message.body.at(-1) as Record<string, Variant<string>>;
          const sender = message.sender.slice(1).replaceAll(".", "_");
          const handle = `${root}/request/${sender}/${options.handle_token!.value}`;
          let results: Record<string, Variant<unknown>>;
          if (message.member === "CreateSession") {
            const session = `${root}/session/${sender}/${options.session_handle_token!.value}`;
            sessions.set(message.sender, session);
            results = { session_handle: new Variant("s", session) };
          } else {
            bindCount++;
            const shortcuts = message.body[1] as Array<
              [string, { preferred_trigger: Variant<string> }]
            >;
            expect(shortcuts).toHaveLength(1);
            const [id, properties] = shortcuts[0]!;
            expect(properties.preferred_trigger.signature).toBe("s");
            bindings.set(message.sender, id);
            const bound = [
              [
                id,
                {
                  description: new Variant("s", "Capture a window"),
                  trigger_description: new Variant("s", properties.preferred_trigger.value),
                },
              ],
            ];
            results = { shortcuts: new Variant("a(sa{sv})", bound) };
          }
          // Exercise the fast-portal race: Response is delivered before the method's handle reply.
          const response = Message.newSignal(
            handle,
            "org.freedesktop.portal.Request",
            "Response",
            "ua{sv}",
            [0, results],
          );
          response.destination = message.sender;
          server!.send(response);
          server!.send(Message.newMethodReturn(message, "o", [handle]));
        } else return false;
        return true;
      });

      const shortcut = {
        key: "2",
        modKey: true,
        ctrlKey: false,
        shiftKey: true,
        altKey: false,
        metaKey: false,
      };
      const start = (key = "2") => {
        const received = Promise.withResolvers<void>();
        const capture = vi.fn(() => received.resolve());
        const client = new PortalCaptureShortcut(
          "com.t3tools.T3Code",
          { ...shortcut, key },
          capture,
          () => {},
          connect(),
        );
        clients.push(client);
        return { client, capture, received: received.promise };
      };
      const activate = (sender: string) => {
        const signal = Message.newSignal(root, iface, "Activated", "osta{sv}", [
          sessions.get(sender),
          bindings.get(sender),
          123,
          {},
        ]);
        signal.destination = sender;
        server!.send(signal);
      };
      const first = start();
      await first.client.ready;
      expect(first.client.state.shortcutRegistered).toBe(true);
      const firstSender = [...bindings.keys()][0]!;
      activate(firstSender);
      await first.received;
      expect(first.capture).toHaveBeenCalledOnce();
      const sessionClosed = new Promise<void>((resolve) =>
        closeWaiters.set(sessions.get(firstSender)!, resolve),
      );
      first.client.close();
      await sessionClosed;
      expect(closed.has(sessions.get(firstSender)!)).toBe(true);

      const restoredClient = start();
      await restoredClient.client.ready;
      expect(restoredClient.client.state.shortcutRegistered).toBe(true);
      expect(bindCount).toBe(2);
      expect([...bindings.values()][1]).toBe(bindings.get(firstSender));
      const next = start("8");
      await next.client.ready;
      expect(next.client.state.shortcutLabel).toBe("CTRL+SHIFT+8");
      expect(bindCount).toBe(3);
      const lastSender = [...bindings.keys()].at(-1)!;
      expect(bindings.get(lastSender)).not.toBe(bindings.get(firstSender));
      activate(lastSender);
      await next.received;
      expect(next.capture).toHaveBeenCalledOnce();
    } finally {
      clients.forEach((client) => client.close());
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
