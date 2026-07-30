import { assert, describe, it } from "@effect/vitest";
import { type DesktopDeepLinkTarget, EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  createDesktopDeepLinkBuffer,
  decodeDesktopDeepLinkTarget,
} from "./DesktopDeepLinkBuffer.ts";

const first: DesktopDeepLinkTarget = {
  type: "thread",
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};
const second: DesktopDeepLinkTarget = { ...first, threadId: ThreadId.make("thread-2") };

describe("DesktopDeepLinkBuffer", () => {
  it("keeps the latest target until the renderer subscribes", () => {
    const buffer = createDesktopDeepLinkBuffer();
    const received: unknown[] = [];
    buffer.publish(first);
    buffer.publish(second);

    buffer.subscribe((target) => received.push(target));

    assert.deepEqual(received, [second]);
  });

  it("forwards targets and stops after unsubscribe", () => {
    const buffer = createDesktopDeepLinkBuffer();
    const received: unknown[] = [];
    const unsubscribe = buffer.subscribe((target) => received.push(target));
    buffer.publish(first);
    unsubscribe();
    buffer.publish(second);

    assert.deepEqual(received, [first]);
  });

  it("rejects malformed IPC payloads", () => {
    assert.deepEqual(decodeDesktopDeepLinkTarget(first), first);
    assert.isNull(decodeDesktopDeepLinkTarget({ ...first, type: "project" }));
    assert.isNull(decodeDesktopDeepLinkTarget({ ...first, environmentId: "" }));
    assert.isNull(decodeDesktopDeepLinkTarget({ ...first, threadId: " thread-1" }));
  });
});
