import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { createExtensionHost } from "../dist/host.js";
import { copyJson, MAX_PAYLOAD_BYTES } from "../dist/contracts.js";

const record = () => ({
  version: 1,
  surfaceId: "test.bounds/view",
  placement: "side-panel",
  stateVersion: 1,
  fallback: "Unavailable",
  restoreState: null,
  context: {
    client: "web",
    resource: {
      namespace: "test.bounds",
      id: "resource",
      environmentId: "env",
      projectId: "project",
    },
  },
});
function extension(createView, capabilities = []) {
  return {
    manifest: {
      id: "test.bounds",
      version: "1.0.0",
      apiVersion: 1,
      surfaces: [
        {
          id: "test.bounds/view",
          title: "Bounds",
          scope: "project",
          clients: ["web"],
          placements: ["side-panel", "bottom-dock"],
          stateVersion: 1,
          capabilities,
        },
      ],
    },
    surfaces: [{ id: "test.bounds/view", validateRestore: () => true, createView }],
  };
}
NodeTest.test(
  "unavailable hide/show preserves fallback and later registration can recover",
  async () => {
    const host = createExtensionHost({ authorize: () => false });
    try {
      const id = await host.restore(record());
      host.hide(id);
      await host.show(id);
      NodeAssert.equal(host.snapshot(id).status, "unavailable");
      host.register(extension(() => ({ renderer: {} })));
      await host.show(id);
      NodeAssert.equal(host.snapshot(id).status, "ready");
    } finally {
      host.dispose();
    }
  },
);
NodeTest.test("denied capability remains unavailable across visibility until granted", async () => {
  let granted = false;
  const host = createExtensionHost({
    authorize: () => granted,
    services: [{ capability: "test.bounds/read", invoke: () => null }],
  });
  host.register(extension(() => ({ renderer: {} }), ["test.bounds/read"]));
  try {
    const id = await host.restore(record());
    host.hide(id);
    await host.show(id);
    NodeAssert.equal(host.snapshot(id).status, "unavailable");
    granted = true;
    await host.show(id);
    NodeAssert.equal(host.snapshot(id).status, "ready");
  } finally {
    host.dispose();
  }
});
NodeTest.test("separately bounded record and presentation remain readable and notify", async () => {
  const host = createExtensionHost({ authorize: () => false });
  let session;
  host.register(
    extension((current) => {
      session = current;
      return { renderer: {} };
    }),
  );
  try {
    const id = await host.restore({ ...record(), restoreState: "r".repeat(40000) });
    const notifications = [];
    host.subscribe((next) => {
      if (next) notifications.push(next);
    });
    NodeAssert.equal(session.publish(1, "p".repeat(40000)), true);
    NodeAssert.equal(session.save("s".repeat(40000)), true);
    await new Promise((resolve) => queueMicrotask(resolve));
    NodeAssert.equal(notifications.length, 1);
    NodeAssert.equal(host.snapshot(id).state.length, 40000);
    const snapshot = host.getSnapshot(id);
    NodeAssert.equal(snapshot.record.restoreState.length, 40000);
    NodeAssert.equal(host.getSnapshot(id), snapshot);
    NodeAssert.ok(Object.isFrozen(snapshot.record));
    NodeAssert.throws(() => session.publish(2, "🌈".repeat(17000)), /byte limit/);
    NodeAssert.equal(host.getSnapshot(id), snapshot);
  } finally {
    host.dispose();
  }
});
NodeTest.test("save rejects a full-record overflow before changing durable state", async () => {
  const host = createExtensionHost({ authorize: () => false });
  let session;
  host.register(
    extension((current) => {
      session = current;
      return { renderer: {} };
    }),
  );
  try {
    const id = await host.restore(record());
    const previous = host.getSnapshot(id);
    const individuallyValid = "r".repeat(MAX_PAYLOAD_BYTES - 3);
    copyJson(individuallyValid);
    NodeAssert.throws(() => session.save(individuallyValid), /byte limit/);
    NodeAssert.equal(host.getSnapshot(id), previous);
    NodeAssert.equal(host.records()[0].restoreState, null);
  } finally {
    host.dispose();
  }
});
NodeTest.test("context and placement updates preserve the complete record byte bound", async () => {
  const host = createExtensionHost({ authorize: () => false });
  host.register(extension(() => ({ renderer: {} })));
  try {
    const exact = record();
    exact.restoreState = "r".repeat(
      MAX_PAYLOAD_BYTES - new TextEncoder().encode(JSON.stringify(exact)).length + 2,
    );
    copyJson(exact);
    const id = await host.restore(exact);
    NodeAssert.throws(() => host.move(id, "bottom-dock"), /byte limit/);
    await NodeAssert.rejects(
      host.updateContext(id, { ...exact.context, workspaceRevision: "new" }),
      /byte limit/,
    );
    NodeAssert.deepEqual(host.records()[0], exact);
  } finally {
    host.dispose();
  }
});
