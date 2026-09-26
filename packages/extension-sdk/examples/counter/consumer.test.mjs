import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { createExtensionHost } from "@t3tools/extension-sdk/host";
import { resourceKey } from "@t3tools/extension-sdk/contracts";
import { counter } from "./dist/counter.js";
NodeTest.test(
  "external package drives public lifecycle, actions, scope and failure isolation",
  async () => {
    const host = createExtensionHost({
      authorize: () => true,
      services: [
        {
          capability: "host.counter/read",
          invoke: ({ context, input }) => ({
            count: input.count + (context.resource.environmentId === "a" ? 1 : 10),
          }),
        },
      ],
    });
    host.register(counter);
    const record = {
      version: 1,
      surfaceId: "example.counter/view",
      context: {
        resource: {
          namespace: "example.counter",
          id: "resource",
          environmentId: "a",
          projectId: "p",
          threadId: "t",
        },
        client: "web",
      },
      placement: "side-panel",
      stateVersion: 1,
      restoreState: null,
      fallback: "Counter unavailable",
    };
    const a = await host.open(record),
      b = await host.open(record);
    const renderer = host.renderer(a);
    await renderer.increment();
    NodeAssert.equal(host.snapshot(a).state.count, 1);
    host.hide(a);
    await host.show(a);
    NodeAssert.equal(host.renderer(a), renderer);
    const saved = host.snapshot(a).record;
    host.close(a);
    const restored = await host.restore(saved);
    NodeAssert.equal(host.renderer(restored).read(), 1);
    await host.updateContext(restored, {
      ...record.context,
      resource: { ...record.context.resource, environmentId: "b" },
    });
    await host.renderer(restored).increment();
    NodeAssert.equal(host.snapshot(restored).state.count, 10);
    NodeAssert.notEqual(
      resourceKey(record.context.resource),
      resourceKey(host.snapshot(restored).record.context.resource),
    );
    host.fail(restored, new Error("view failed"));
    await host.renderer(b).increment();
    NodeAssert.equal(host.snapshot(b).state.count, 1);
    host.disable("example.counter");
    const unavailable = await host.restore(saved);
    NodeAssert.equal(host.snapshot(unavailable).status, "unavailable");
    NodeAssert.equal(host.snapshot(unavailable).record.fallback, "Counter unavailable");
    host.dispose();
    NodeAssert.equal(host.diagnostics().views, 0);
  },
);
NodeTest.test("package resolver denies private SDK imports", async () => {
  await NodeAssert.rejects(import("@t3tools/extension-sdk/src/host.js"), {
    code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
  });
});
