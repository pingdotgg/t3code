// @effect-diagnostics nodeBuiltinImport:off -- Event-driven fake of the session bus transport.
import * as NodeEvents from "node:events";
import { DBusError, Message, MessageType, type MessageBus } from "dbus-next";
import { expect, it, vi } from "vite-plus/test";

import { watchLinuxNotificationService } from "./LinuxNotificationService.ts";

class FakeBus extends NodeEvents.EventEmitter {
  readonly calls: Message[] = [];
  readonly replies: Array<PromiseWithResolvers<Message>> = [];
  disconnect = vi.fn();

  call(message: Message) {
    this.calls.push(message);
    const reply = Promise.withResolvers<Message>();
    this.replies.push(reply);
    return reply.promise;
  }

  // StartServiceByName answers 1 when it started the service and 2 when it was already running.
  async answer(index: number, result: 1 | 2) {
    const reply = this.replies[index]!;
    reply.resolve(
      new Message({
        type: MessageType.METHOD_RETURN,
        replySerial: "1",
        signature: "u",
        body: [result],
      }),
    );
    await Promise.allSettled([reply.promise]);
  }

  async fail(index: number, error: DBusError) {
    const reply = this.replies[index]!;
    reply.reject(error);
    await Promise.allSettled([reply.promise]);
  }
}

const watch = (bus: FakeBus) => watchLinuxNotificationService(bus as unknown as MessageBus);

it("does not offer notifications while the notification service is still being activated", () => {
  const bus = new FakeBus();
  const service = watch(bus);

  // An activatable service that never claims its name keeps this call pending until the bus's
  // activation timeout, which libnotify would otherwise wait out on Electron's main thread.
  expect(service.available()).toBe(false);
  expect(bus.calls).toHaveLength(1);
  expect(bus.calls[0]).toMatchObject({
    destination: "org.freedesktop.DBus",
    path: "/org/freedesktop/DBus",
    interface: "org.freedesktop.DBus",
    member: "StartServiceByName",
    signature: "su",
    body: ["org.freedesktop.Notifications", 0],
  });
  service.stop();
});

it("offers notifications once the notification service is running", async () => {
  const bus = new FakeBus();
  const service = watch(bus);

  await bus.answer(0, 1);

  expect(service.available()).toBe(true);
  expect(bus.calls).toHaveLength(1);
  service.stop();
});

it("keeps notifications off after activation fails and probes again on the next check", async () => {
  const bus = new FakeBus();
  const service = watch(bus);

  await bus.fail(
    0,
    new DBusError(
      "org.freedesktop.DBus.Error.TimedOut",
      "Activation of org.freedesktop.Notifications timed out",
    ),
  );

  expect(service.available()).toBe(false);
  expect(bus.calls).toHaveLength(2);
  expect(service.available()).toBe(false);
  expect(bus.calls).toHaveLength(2);

  await bus.answer(1, 2);

  expect(service.available()).toBe(true);
  service.stop();
});
