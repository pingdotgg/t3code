import { assert, describe, it } from "@effect/vitest";

import { makeMenuActionInbox } from "./menuActionInbox.ts";

describe("makeMenuActionInbox", () => {
  it("replays actions delivered before a listener subscribes", () => {
    const inbox = makeMenuActionInbox();
    inbox.deliver("open-settings");
    inbox.deliver("new-thread");

    const received: string[] = [];
    inbox.subscribe((action) => received.push(action));

    assert.deepEqual(received, ["open-settings", "new-thread"]);
  });

  it("delivers directly once subscribed and replays nothing twice", () => {
    const inbox = makeMenuActionInbox();
    inbox.deliver("open-settings");

    const first: string[] = [];
    const unsubscribe = inbox.subscribe((action) => first.push(action));
    inbox.deliver("new-thread");
    unsubscribe();

    const second: string[] = [];
    inbox.subscribe((action) => second.push(action));

    assert.deepEqual(first, ["open-settings", "new-thread"]);
    assert.deepEqual(second, []);
  });

  it("buffers again after unsubscribing", () => {
    const inbox = makeMenuActionInbox();
    const unsubscribe = inbox.subscribe(() => {});
    unsubscribe();
    inbox.deliver("open-settings");

    const received: string[] = [];
    inbox.subscribe((action) => received.push(action));

    assert.deepEqual(received, ["open-settings"]);
  });
});
