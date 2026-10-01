import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeTest from "node:test";
import {
  React,
  REF,
  act,
  defaultHandlers,
  deferred,
  detailOf,
  flush as flushPanel,
  loadPrsPanel,
  mount,
} from "./prsPanelHarness.mjs";

let panel;
const pendingDigests = new Set();
NodeTest.before(async () => {
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  NodeTest.mock.method(crypto.subtle, "digest", (...args) => {
    const pending = digest(...args);
    pendingDigests.add(pending);
    void pending.then(
      () => pendingDigests.delete(pending),
      () => pendingDigests.delete(pending),
    );
    return pending;
  });
  panel = await loadPrsPanel();
});
NodeTest.after(() => NodeTest.mock.restoreAll());

// Native diff hashing may still be pending after the panel's queued updates land.
async function flush() {
  await flushPanel();
  await act(async () => {
    await Promise.all(pendingDigests);
  });
}

const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
const hash = NodeCrypto.createHash("sha256").update(patch).digest("hex");
const frames = [
  {
    kind: "manifest",
    ...REF,
    diffHash: hash,
    diffByteLength: Buffer.byteLength(patch),
    chunkCount: 1,
    truncated: false,
    nextCursor: null,
  },
  { kind: "chunk", chunkIndex: 0, data: patch },
  { kind: "complete", payloadSha256: hash },
];

function mountViewed({
  store = "host",
  support = true,
  readSupport = true,
  files = [],
  truncated = false,
  write = () => ({}),
  read,
  detailRead,
  patchText = patch,
  notifications = false,
  notify = () => ({ notificationId: "viewed-failure" }),
} = {}) {
  let snapshot = { filesViewed: { files, truncated } };
  const patchHash = NodeCrypto.createHash("sha256").update(patchText).digest("hex");
  const diffFrames = [
    { ...frames[0], diffHash: patchHash, diffByteLength: Buffer.byteLength(patchText) },
    { ...frames[1], data: patchText },
    { ...frames[2], payloadSha256: patchHash },
  ];
  const base = defaultHandlers();
  const handlers = {
    ...base,
    "t3.prs/read#getCapabilities": () => ({
      ...base["t3.prs/read#getCapabilities"](),
      operations: {
        ...base["t3.prs/read#getCapabilities"]().operations,
        "prs.streamDiff": true,
        ...(readSupport === null ? {} : { "prs.filesViewed": store !== null && readSupport }),
      },
    }),
    "t3.prs/write#getCapabilities": () => ({
      ...base["t3.prs/write#getCapabilities"](),
      operations: {
        ...base["t3.prs/write#getCapabilities"]().operations,
        ...(support === null ? {} : { "prs.setFilesViewed": support }),
      },
    }),
    "t3.prs/read#detail": () => {
      const detail = detailOf();
      const result = {
        ...detail,
        capabilities: { ...detail.capabilities, ...(store === null ? {} : { viewedFiles: store }) },
        ...snapshot,
      };
      return detailRead === undefined ? result : detailRead(result);
    },
    "t3.prs/write#setFilesViewed": write,
    "t3.prs/read#filesViewed": (input) =>
      read === undefined ? { ...snapshot.filesViewed, nextCursor: null } : read(input),
    ...(notifications
      ? {
          "t3.ui/notifications#getCapabilities": () => ({
            adapter: "web",
            operations: { notify: true, update: true },
            clients: ["web"],
          }),
          "t3.ui/notifications#notify": notify,
        }
      : {}),
  };
  const view = mount(
    (host, session) =>
      React.createElement(panel.PullRequestsPanel, {
        host,
        session,
        visible: true,
        selected: REF,
        onSelect: () => {},
      }),
    handlers,
    {
      subscribeApi: (request, signal) =>
        (async function* () {
          if (request.name === "streamDiff") {
            for (const [sequence, value] of diffFrames.entries())
              yield { streamId: "diff", sequence, type: "data", value };
          } else {
            await new Promise((resolve) =>
              signal.addEventListener("abort", resolve, { once: true }),
            );
          }
        })(),
    },
  );
  return {
    ...view,
    setSnapshot: (next) => {
      snapshot = next;
    },
  };
}

const checkbox = (view) =>
  view.renderer.root.findAll((node) => node.type === "input" && node.props.type === "checkbox")[0];
const setViewed = async (view, checked) => {
  await act(async () => {
    checkbox(view).props.onChange({ target: { checked } });
  });
};
const send = async (context) => {
  await act(async () => {
    context.mock.timers.tick(400);
  });
  await flush();
};

for (const [path, written] of [
  ["café-日本語.txt", '"caf\\303\\251-\\346\\227\\245\\346\\234\\254\\350\\252\\236.txt"'],
  ["cafe\u0301-日本語.txt", "cafe\u0301-日本語.txt"],
  ["with spaces.txt", "with spaces.txt"],
  ['quote"and\\backslash.txt', '"quote\\"and\\\\backslash.txt"'],
  ["b/nested.txt", "b/nested.txt"],
]) {
  NodeTest.test(`viewed writes and readback use the real path: ${path}`, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const side = (prefix) =>
      written.startsWith('"') ? `"${prefix}/${written.slice(1)}` : `${prefix}/${written}`;
    const view = mountViewed({
      patchText: `diff --git ${side("a")} ${side("b")}\n--- ${side("a")}\n+++ ${side("b")}\n@@ -1 +1 @@\n-old\n+new\n`,
      write: () => ({}),
    });
    try {
      await flush();
      NodeAssert.equal(view.has(`Collapse ${path}`), true);
      await setViewed(view, true);
      view.setSnapshot({ filesViewed: { files: [{ path, state: "viewed" }], truncated: false } });
      await send(context);
      NodeAssert.deepEqual(view.writes()[0].input.files, [{ path, viewed: true }]);
      NodeAssert.equal(checkbox(view).props.checked, true);
      await setViewed(view, false);
      view.setSnapshot({ filesViewed: { files: [{ path, state: "unviewed" }], truncated: false } });
      await send(context);
      NodeAssert.deepEqual(view.writes()[1].input.files, [{ path, viewed: false }]);
      NodeAssert.equal(checkbox(view).props.checked, false);
    } finally {
      view.unmount();
    }
  });
}

NodeTest.test(
  "file ticks toggle immediately, fold the file, and roll back failed writes",
  async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const pending = deferred();
    const view = mountViewed({ write: () => pending.promise, notifications: true });
    try {
      await flush();
      NodeAssert.equal(checkbox(view).props.checked, false);
      await setViewed(view, true);
      NodeAssert.equal(checkbox(view).props.checked, true);
      NodeAssert.equal(view.has("Expand a.ts"), true);
      await send(context);
      NodeAssert.deepEqual(view.writes()[0].input, {
        ...REF,
        files: [{ path: "a.ts", viewed: true }],
      });
      NodeAssert.equal(view.writes()[0].versionRange, "^1.1.0");
      pending.reject(new Error("host refused"));
      await flush();
      NodeAssert.equal(checkbox(view).props.checked, false);
      NodeAssert.doesNotMatch(view.text(), /host refused/);
      NodeAssert.equal(view.renderer.root.findAll((node) => node.props.role === "alert").length, 0);
      NodeAssert.equal(
        view.calls.filter((call) => call.id === "t3.ui/notifications" && call.method === "notify")
          .length,
        1,
      );
      await setViewed(view, false);
      NodeAssert.equal(view.has("Collapse a.ts"), true);
    } finally {
      view.unmount();
    }
  },
);

NodeTest.test(
  "success stays optimistic until the re-read and reveals a file pushed since viewing",
  async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const pending = deferred();
    const view = mountViewed({
      store: "environment",
      truncated: true,
      write: () => pending.promise,
    });
    try {
      await flush();
      NodeAssert.match(view.text(), /viewed in T3 Code/);
      NodeAssert.match(view.text(), /partial count/);
      await setViewed(view, true);
      await send(context);
      view.setSnapshot({
        filesViewed: { files: [{ path: "a.ts", state: "dismissed" }], truncated: false },
      });
      pending.resolve({});
      await flush();
      NodeAssert.equal(checkbox(view).props.checked, false);
      NodeAssert.equal(checkbox(view).props["aria-label"], "Changed");
      NodeAssert.match(view.text(), /Changed/);
      NodeAssert.equal(view.calls.filter((call) => call.method === "detail").length, 1);
      NodeAssert.equal(view.calls.filter((call) => call.method === "filesViewed").length, 2);
      NodeAssert.equal(
        view.calls.find((call) => call.method === "filesViewed").versionRange,
        "^1.2.0",
      );
    } finally {
      view.unmount();
    }
  },
);

NodeTest.test("a failed earlier request cannot roll back a later press", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const first = deferred();
  const second = deferred();
  let requests = 0;
  const view = mountViewed({ write: () => (++requests === 1 ? first.promise : second.promise) });
  try {
    await flush();
    await setViewed(view, true);
    await send(context);
    await setViewed(view, false);
    first.reject(new Error("older write refused"));
    await flush();
    NodeAssert.equal(checkbox(view).props.checked, false);
    NodeAssert.doesNotMatch(view.text(), /Could not update viewed files/);
    await send(context);
    NodeAssert.equal(view.writes()[1].input.files[0].viewed, false);
    second.resolve({});
    await flush();
    NodeAssert.equal(checkbox(view).props.checked, false);
  } finally {
    view.unmount();
  }
});

NodeTest.test("old or unsupported hosts expose no viewed controls", async () => {
  for (const options of [
    { store: null },
    { support: false },
    { support: null },
    { readSupport: false },
    { readSupport: null },
  ]) {
    const view = mountViewed(options);
    try {
      await flush();
      NodeAssert.equal(checkbox(view), undefined);
      NodeAssert.doesNotMatch(view.text(), /viewed in T3 Code/);
      NodeAssert.equal(view.writes().length, 0);
    } finally {
      view.unmount();
    }
  }
});

NodeTest.test(
  "late panel detail cannot retire a press against stale viewed fields",
  async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const staleDetail = deferred();
    let details = 0;
    let reads = 0;
    let oldDetail;
    const view = mountViewed({
      detailRead: (value) => {
        if (++details === 1) return value;
        oldDetail = value;
        return staleDetail.promise;
      },
      read: () => ({
        files: ++reads < 3 ? [] : [{ path: "a.ts", state: "viewed" }],
        truncated: false,
        nextCursor: null,
      }),
    });
    try {
      await flush();
      await act(async () => view.find("Refresh").props.onClick());
      await flush();
      await setViewed(view, true);
      await send(context);
      staleDetail.resolve({ ...oldDetail, title: "Late detail landed" });
      await flush();
      NodeAssert.match(view.text(), /Late detail landed/);
      NodeAssert.equal(checkbox(view).props.checked, true);
      NodeAssert.equal(details, 2);
      NodeAssert.equal(reads, 3);
    } finally {
      view.unmount();
    }
  },
);

NodeTest.test(
  "a tick preserves unrelated file render identity through write and re-read",
  async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const view = mountViewed({ patchText: patch + patch.replaceAll("a.ts", "b.ts") });
    try {
      await flush();
      const other = () =>
        view.renderer.root.findAll(
          (node) => node.type === "section" && node.props["aria-label"] === "b.ts",
        )[0];
      const children = other().props.children;
      await setViewed(view, true);
      NodeAssert.ok(
        other().props.children === children,
        "an unrelated file must not re-render on a press",
      );
      view.setSnapshot({
        filesViewed: { files: [{ path: "a.ts", state: "viewed" }], truncated: false },
      });
      await send(context);
      NodeAssert.ok(
        other().props.children === children,
        "an unrelated file must not re-render on settlement",
      );
    } finally {
      view.unmount();
    }
  },
);

NodeTest.test("Refresh invalidates viewed cache and reads every dedicated page", async () => {
  const view = mountViewed({
    read: (input) =>
      input.cursor === undefined
        ? { files: [], truncated: false, nextCursor: "1" }
        : { files: [{ path: "a.ts", state: "viewed" }], truncated: false, nextCursor: null },
  });
  try {
    await flush();
    NodeAssert.equal(checkbox(view).props.checked, true);
    await act(async () => view.find("Refresh").props.onClick());
    await flush();
    NodeAssert.ok(
      view.calls.some(
        (call) => call.method === "invalidate" && call.input.filesViewedOnly === true,
      ),
    );
    NodeAssert.equal(view.calls.filter((call) => call.method === "filesViewed").length, 4);
  } finally {
    view.unmount();
  }
});

for (const nextCursor of ["1", "0"]) {
  NodeTest.test(`viewed paging stops at a non-advancing cursor ${nextCursor}`, async () => {
    let reads = 0;
    const view = mountViewed({
      read: () => ({
        files: [{ path: "a.ts", state: "viewed" }],
        truncated: false,
        nextCursor: ++reads === 1 ? "1" : reads === 2 ? nextCursor : null,
      }),
    });
    try {
      await flush();
      NodeAssert.equal(reads, 2);
      NodeAssert.equal(checkbox(view).props.checked, false);
      NodeAssert.match(view.text(), /Your ticks could not be read/);
    } finally {
      view.unmount();
    }
  });
}

NodeTest.test(
  "viewed paging restarts once when the list changes, including on the last page",
  async () => {
    const pages = [
      { files: [{ path: "a.ts", state: "viewed" }], snapshot: "a".repeat(64), nextCursor: "1" },
      {
        files: [{ path: "other.ts", state: "viewed" }],
        snapshot: "b".repeat(64),
        nextCursor: null,
      },
      { files: [{ path: "other.ts", state: "viewed" }], snapshot: "b".repeat(64), nextCursor: "1" },
      { files: [{ path: "a.ts", state: "dismissed" }], snapshot: "b".repeat(64), nextCursor: null },
    ];
    const inputs = [];
    const view = mountViewed({
      read: (input) => {
        inputs.push(input);
        return { ...pages[inputs.length - 1], truncated: false };
      },
    });
    try {
      await flush();
      NodeAssert.deepEqual(
        inputs.map((input) => input.cursor ?? null),
        [null, "1", null, "1"],
      );
      NodeAssert.equal(checkbox(view).props.checked, false);
      NodeAssert.equal(checkbox(view).props["aria-label"], "Changed");
      NodeAssert.doesNotMatch(view.text(), /Your ticks could not be read/);
    } finally {
      view.unmount();
    }
  },
);

NodeTest.test(
  "viewed paging discloses a second turnover without retrying indefinitely",
  async () => {
    let reads = 0;
    const view = mountViewed({
      read: () => {
        reads += 1;
        return {
          files: [{ path: "a.ts", state: "viewed" }],
          truncated: false,
          snapshot: String(reads).repeat(64),
          nextCursor: reads % 2 === 1 ? "1" : null,
        };
      },
    });
    try {
      await flush();
      NodeAssert.equal(reads, 4);
      NodeAssert.equal(checkbox(view).props.checked, false);
      NodeAssert.match(view.text(), /Your ticks could not be read/);
    } finally {
      view.unmount();
    }
  },
);

for (const notifications of [false, true]) {
  NodeTest.test(
    `failed viewed writes remain disclosed when toasts ${notifications ? "die" : "are unavailable"}`,
    async (context) => {
      context.mock.timers.enable({ apis: ["setTimeout"] });
      const view = mountViewed({
        notifications,
        write: () => Promise.reject(new Error("private host detail")),
        notify: () => Promise.reject(new Error("private notification detail")),
      });
      try {
        await flush();
        await setViewed(view, true);
        await send(context);
        NodeAssert.equal(checkbox(view).props.checked, false);
        NodeAssert.match(view.text(), /Could not update viewed files/);
        NodeAssert.doesNotMatch(view.text(), /private .* detail/);
      } finally {
        view.unmount();
      }
    },
  );
}

for (const notifications of [false, true]) {
  NodeTest.test(
    `successful retry clears an inline viewed failure when toasts ${notifications ? "die" : "are unavailable"}`,
    async (context) => {
      context.mock.timers.enable({ apis: ["setTimeout"] });
      const retry = deferred();
      let writes = 0;
      const view = mountViewed({
        notifications,
        write: () =>
          ++writes === 1 ? Promise.reject(new Error("private host detail")) : retry.promise,
        notify: () => Promise.reject(new Error("private notification detail")),
      });
      try {
        await flush();
        await setViewed(view, true);
        await send(context);
        NodeAssert.match(view.text(), /Could not update viewed files/);
        await setViewed(view, true);
        await send(context);
        NodeAssert.match(view.text(), /Could not update viewed files/);
        view.setSnapshot({
          filesViewed: { files: [{ path: "a.ts", state: "viewed" }], truncated: false },
        });
        retry.resolve({});
        await flush();
        NodeAssert.equal(writes, 2);
        NodeAssert.equal(checkbox(view).props.checked, true);
        NodeAssert.doesNotMatch(view.text(), /Could not update viewed files/);
      } finally {
        view.unmount();
      }
    },
  );
}

NodeTest.test(
  "a pre-write read landing last cannot replace fresher viewed state",
  async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const stale = deferred();
    const fresh = deferred();
    let reads = 0;
    const view = mountViewed({ read: () => (++reads === 1 ? stale.promise : fresh.promise) });
    try {
      await flush();
      await setViewed(view, true);
      await send(context);
      fresh.resolve({
        files: [{ path: "a.ts", state: "viewed" }],
        truncated: false,
        nextCursor: null,
      });
      await flush();
      stale.resolve({ files: [], truncated: false, nextCursor: null });
      await flush();
      NodeAssert.equal(checkbox(view).props.checked, true);
      NodeAssert.equal(reads, 2);
    } finally {
      view.unmount();
    }
  },
);

NodeTest.test(
  "a refused viewed batch reconciles files that the host did persist",
  async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const view = mountViewed({
      write: () => {
        view.setSnapshot({
          filesViewed: { files: [{ path: "a.ts", state: "viewed" }], truncated: false },
        });
        return Promise.reject(new Error("Host did not confirm the whole batch"));
      },
    });
    try {
      await flush();
      await setViewed(view, true);
      await send(context);
      NodeAssert.match(view.text(), /Could not update viewed files/);
      NodeAssert.equal(checkbox(view).props.checked, true);
    } finally {
      view.unmount();
    }
  },
);
