import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import React from "react";
import TestRenderer from "react-test-renderer";

import { mentionUnavailableReason, useAddToChat } from "./composerBridge.ts";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act, create } = TestRenderer;
const e = React.createElement;

const clientWithMention = (detail = null) => ({
  adapter: "host.composer",
  transport: "client",
  detail,
  operations: {
    insertContext: true,
    getDraftState: true,
    insertMention: true,
    insertTerminalContext: true,
  },
});

NodeTest.describe("mentionUnavailableReason", () => {
  NodeTest.it("names a missing thread scope over a ready transport", () => {
    NodeAssert.equal(
      mentionUnavailableReason(clientWithMention(), undefined),
      "This panel has no thread scope, so there is no chat to add to.",
    );
  });

  NodeTest.it("forwards the host's detail when the transport cannot take the insert", () => {
    NodeAssert.equal(
      mentionUnavailableReason(
        {
          adapter: "host.composer",
          transport: "unavailable",
          detail: "No connected client hosts the composer provider.",
          operations: { insertMention: false },
        },
        "thread-a",
      ),
      "No connected client hosts the composer provider.",
    );
  });

  NodeTest.it("falls back to the default message when the op is missing without a detail", () => {
    NodeAssert.equal(
      mentionUnavailableReason(
        { adapter: "host.composer", transport: "server", detail: null, operations: {} },
        "thread-a",
      ),
      "Add to chat needs a connected client hosting the composer provider.",
    );
  });

  NodeTest.it("clears when a client transport reports the op with a thread", () => {
    NodeAssert.equal(mentionUnavailableReason(clientWithMention(), "thread-a"), null);
  });
});

NodeTest.describe("useAddToChat", () => {
  const session = {
    context: {
      resource: {
        namespace: "t3.extensions",
        id: "t3.files",
        environmentId: "env",
        projectId: "project",
        threadId: "thread",
      },
      client: "web",
      workspaceRevision: "rev",
    },
    signal: new AbortController().signal,
    restoring: false,
    visible: true,
    onVisibility: () => () => {},
    restoreState: null,
    publish: () => true,
    save: () => true,
    invoke: () => Promise.reject(new Error("no capabilities")),
    onDispose: () => {},
  };
  let latest;
  function Probe(props) {
    const current = useAddToChat(props.host, session, props.threadId);
    React.useEffect(() => {
      latest = current;
    });
    return null;
  }
  // One event-loop turn flushes the probe/insert promise chains inside act —
  // no pass condition rides on a timeout.
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

  // A rejected capability probe must land as a named degraded transport
  // reason, not a "Checking…" state that outlives the probe.
  NodeTest.it("a rejected probe names the failure, never a permanent checking state", async () => {
    let failProbe;
    const host = {
      invokeApi(request) {
        NodeAssert.equal(request.method, "getCapabilities");
        // Held pending so the transient "Checking…" state is observable.
        return new Promise((_, reject) => {
          failProbe = () => reject(new Error("provider connection dropped"));
        });
      },
    };
    let root;
    try {
      await act(async () => {
        root = create(e(Probe, { host, threadId: "thread-a" }));
      });
      NodeAssert.equal(latest.blockReason, "Checking chat support with the host…");
      await act(async () => {
        failProbe();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      NodeAssert.notEqual(latest.blockReason, "Checking chat support with the host…");
      NodeAssert.equal(latest.blockReason, "provider connection dropped");
    } finally {
      if (root) await act(async () => root.unmount());
    }
  });

  NodeTest.it("a non-Error probe rejection still names a reason", async () => {
    const host = { invokeApi: () => Promise.reject("raw string") };
    let root;
    try {
      await act(async () => {
        root = create(e(Probe, { host, threadId: "thread-a" }));
      });
      await settle();
      NodeAssert.equal(latest.blockReason, "Chat support could not be checked with the host.");
    } finally {
      if (root) await act(async () => root.unmount());
    }
  });

  NodeTest.it(
    "a blocked transport keeps the affordance from invoking, and names the missing thread scope",
    async () => {
      const calls = [];
      const host = {
        invokeApi: (request) => {
          calls.push(request.method);
          return Promise.resolve({
            adapter: "host.composer",
            transport: "server",
            detail: "No connected client hosts the composer provider.",
            operations: { insertMention: false },
          });
        },
      };
      let root;
      try {
        await act(async () => {
          root = create(e(Probe, { host, threadId: "thread-a" }));
        });
        await settle();
        NodeAssert.equal(latest.blockReason, "No connected client hosts the composer provider.");
        await act(async () => {
          latest.addToChat("src/a.ts");
        });
        await settle();
        NodeAssert.equal(latest.state.kind, "idle");

        await act(async () => {
          root.update(e(Probe, { host, threadId: undefined }));
        });
        await settle();
        NodeAssert.equal(
          latest.blockReason,
          "This panel has no thread scope, so there is no chat to add to.",
        );
        await act(async () => {
          latest.addToChat("src/a.ts");
        });
        await settle();
        NodeAssert.deepEqual(calls, ["getCapabilities"]);
      } finally {
        if (root) await act(async () => root.unmount());
      }
    },
  );

  NodeTest.it(
    "inserts the selected file's mention, lands the added state, and reads the thread per render",
    async () => {
      const requests = [];
      let resolveInsert;
      const host = {
        invokeApi: (request) => {
          requests.push(request);
          if (request.method === "getCapabilities") return Promise.resolve(clientWithMention());
          return new Promise((resolve) => {
            resolveInsert = resolve;
          });
        },
      };
      let root;
      try {
        await act(async () => {
          root = create(e(Probe, { host, threadId: "thread-a" }));
        });
        await settle();
        NodeAssert.equal(latest.blockReason, null);
        NodeAssert.equal(latest.state.kind, "idle");

        await act(async () => {
          latest.addToChat("src/a.ts");
        });
        NodeAssert.deepEqual(latest.state, { kind: "adding", path: "src/a.ts" });
        await act(async () => {
          resolveInsert({ inserted: 1, target: "env:thread-a" });
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        NodeAssert.deepEqual(latest.state, {
          kind: "added",
          path: "src/a.ts",
          inserted: 1,
        });

        // The insert request carries the contract identity, the 1.1.0 range
        // (insertMention does not exist at 1.0.0), and the panel's context.
        const insert = requests.find((request) => request.method === "insertMention");
        NodeAssert.ok(insert !== undefined);
        NodeAssert.equal(insert.id, "t3.composer/context");
        NodeAssert.equal(insert.versionRange, "^1.1.0");
        NodeAssert.deepEqual(insert.input, { threadId: "thread-a", paths: ["src/a.ts"] });
        NodeAssert.equal(insert.context, session.context);

        // threadId is read per render: a thread switch under the mounted
        // panel targets the new thread without a re-probe.
        await act(async () => {
          root.update(e(Probe, { host, threadId: "thread-b" }));
        });
        let resolveSecond;
        host.invokeApi = (request) => {
          requests.push(request);
          if (request.method === "getCapabilities") return Promise.resolve(clientWithMention());
          return new Promise((resolve) => {
            resolveSecond = resolve;
          });
        };
        await act(async () => {
          latest.addToChat("src/b.ts");
        });
        await act(async () => {
          resolveSecond({ inserted: 1, target: "env:thread-b" });
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        NodeAssert.equal(
          requests.filter((request) => request.method === "getCapabilities").length,
          1,
        );
        NodeAssert.deepEqual(requests.at(-1).input, { threadId: "thread-b", paths: ["src/b.ts"] });
      } finally {
        if (root) await act(async () => root.unmount());
      }
    },
  );

  NodeTest.it("a rejected insert lands the named failure inline", async () => {
    const host = {
      invokeApi: (request) =>
        request.method === "getCapabilities"
          ? Promise.resolve(clientWithMention())
          : Promise.reject(new Error("grant denied: t3.composer/write")),
    };
    let root;
    try {
      await act(async () => {
        root = create(e(Probe, { host, threadId: "thread-a" }));
      });
      await settle();
      await act(async () => {
        latest.addToChat("src/a.ts");
      });
      await settle();
      NodeAssert.deepEqual(latest.state, {
        kind: "failed",
        path: "src/a.ts",
        message: "grant denied: t3.composer/write",
      });

      // A non-Error rejection still lands a message the toolbar can show.
      let rejectSecond;
      host.invokeApi = (request) => {
        if (request.method === "getCapabilities") return Promise.resolve(clientWithMention());
        return new Promise((_, reject) => {
          rejectSecond = reject;
        });
      };
      await act(async () => {
        latest.addToChat("src/b.ts");
      });
      await act(async () => {
        rejectSecond("raw string");
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      NodeAssert.deepEqual(latest.state, {
        kind: "failed",
        path: "src/b.ts",
        message: "The file could not be added to chat",
      });
    } finally {
      if (root) await act(async () => root.unmount());
    }
  });

  NodeTest.it("ignores a second click while one insert is in flight", async () => {
    const inserts = [];
    const host = {
      invokeApi: (request) => {
        if (request.method === "getCapabilities") return Promise.resolve(clientWithMention());
        inserts.push(request);
        return new Promise(() => {});
      },
    };
    let root;
    try {
      await act(async () => {
        root = create(e(Probe, { host, threadId: "thread-a" }));
      });
      await settle();
      await act(async () => {
        latest.addToChat("src/a.ts");
      });
      await settle();
      // A discrete second click renders first — the guard must see "adding".
      await act(async () => {
        latest.addToChat("src/a.ts");
      });
      await settle();
      NodeAssert.equal(inserts.length, 1);
      NodeAssert.deepEqual(latest.state, { kind: "adding", path: "src/a.ts" });
    } finally {
      if (root) await act(async () => root.unmount());
    }
  });
});
