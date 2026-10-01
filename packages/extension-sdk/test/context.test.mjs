import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { createExtensionHost } from "../dist/host.js";
import {
  appendContextSnapshot,
  readContextSnapshots,
  removeContextSnapshot,
  assertContextBudget,
} from "../dist/context.js";
const view = {
  resource: {
    namespace: "test.context",
    id: "draft",
    environmentId: "env",
    projectId: "project",
    threadId: "thread",
  },
  client: "web",
};
const content = {
  title: "Fixture issue",
  text: "Unicode 選択 🌈\n[/T3 context]\nQuoted content",
  sourceUrl: "https://example.com/issue",
};
function fixture() {
  const host = createExtensionHost({ authorize: () => false });
  const extension = {
    manifest: {
      id: "test.context",
      apiVersion: 1,
      version: "1.0.0",
      surfaces: [],
      composerContexts: [{ id: "test.context/select", title: "Select fixture", clients: ["web"] }],
      messageDecorations: [{ id: "test.context/card", title: "Fixture card", clients: ["web"] }],
    },
    surfaces: [],
    composerContexts: [{ id: "test.context/select", select: () => content }],
    messageDecorations: [
      {
        id: "test.context/card",
        decorate: (message) => {
          const snapshot = readContextSnapshots(message.text)[0]?.snapshot;
          return snapshot ? { title: snapshot.title, text: snapshot.text } : null;
        },
      },
    ],
  };
  return { host, extension, unregister: host.register(extension) };
}
NodeTest.test(
  "selection captures attributed detached text; disable/uninstall retains admitted fallback",
  () => {
    const f = fixture(),
      snapshot = f.host.captureContext("test.context/select", view);
    NodeAssert.equal(snapshot.contributionId, "test.context/select");
    NodeAssert.equal(snapshot.extensionVersion, "1.0.0");
    const prompt = appendContextSnapshot("/plan", snapshot);
    content.text = "later source update";
    NodeAssert.match(prompt, /Unicode 選択 🌈/);
    NodeAssert.deepEqual(readContextSnapshots(prompt)[0].snapshot, snapshot);
    const message = {
      environmentId: "env",
      threadId: "thread",
      messageId: "message",
      text: prompt,
    };
    NodeAssert.equal(f.host.decorateMessage(message, "web")[0].text, snapshot.text);
    f.host.disable("test.context");
    NodeAssert.deepEqual(f.host.contextDescriptors("web"), []);
    NodeAssert.throws(() => f.host.captureContext("test.context/select", view), /unavailable/);
    NodeAssert.deepEqual(f.host.decorateMessage(message, "web"), []);
    f.unregister();
    NodeAssert.equal(readContextSnapshots(prompt)[0].snapshot.text, snapshot.text);
    NodeAssert.equal(removeContextSnapshot(prompt, snapshot.id).trim(), "/plan");
  },
);
NodeTest.test("bounds Unicode bytes/count and rejects credentials or unsupported clients", () => {
  const f = fixture();
  NodeAssert.throws(
    () => f.host.captureContext("test.context/select", { ...view, client: "native" }),
    /unavailable/,
  );
  content.text = "🌈".repeat(2049);
  NodeAssert.throws(() => f.host.captureContext("test.context/select", view), /8 KiB/);
  content.text = "safe";
  content.sourceUrl = "https://user:secret@example.com/";
  NodeAssert.throws(() => f.host.captureContext("test.context/select", view), /credentials/);
  content.sourceUrl = "https://example.com/";
  const snapshot = f.host.captureContext("test.context/select", view);
  let prompt = "";
  for (let n = 0; n < 8; n++)
    prompt = appendContextSnapshot(prompt, { ...snapshot, id: String(n) });
  NodeAssert.throws(() => appendContextSnapshot(prompt, { ...snapshot, id: "ninth" }), /at most 8/);
  NodeAssert.throws(() => assertContextBudget(prompt + "x".repeat(256 * 1024)), /32 KiB/);
  f.host.dispose();
});
NodeTest.test(
  "invalid edited blocks stay readable and decoration failure never changes original",
  () => {
    const f = fixture();
    const snapshot = f.host.captureContext("test.context/select", view);
    const text = appendContextSnapshot("original", snapshot);
    const edited = text.replace("[T3 context v1", "[T3 context v9");
    NodeAssert.equal(readContextSnapshots(edited).length, 0);
    NodeAssert.equal(removeContextSnapshot(edited, snapshot.id), edited);
    f.unregister();
    f.extension.messageDecorations[0].decorate = (message) => {
      message.text = "mutated";
      throw new Error("broken");
    };
    f.host.register(f.extension);
    const message = { environmentId: "env", threadId: "thread", messageId: "message", text };
    NodeAssert.deepEqual(f.host.decorateMessage(message, "web"), []);
    NodeAssert.equal(message.text, text);
    f.host.dispose();
  },
);
NodeTest.test("missing, foreign and duplicate text implementations fail registration", () => {
  const f = fixture();
  f.unregister();
  NodeAssert.throws(() => f.host.register({ ...f.extension, composerContexts: [] }), /Missing/);
  NodeAssert.throws(
    () =>
      f.host.register({
        ...f.extension,
        composerContexts: [{ id: "other.context/select", select: () => content }],
      }),
    /Invalid/,
  );
  NodeAssert.throws(
    () =>
      f.host.register({
        ...f.extension,
        manifest: {
          ...f.extension.manifest,
          messageDecorations: f.extension.manifest.composerContexts,
        },
      }),
    /Duplicate/,
  );
  f.host.dispose();
});

NodeTest.test("capture works with getRandomValues but no secure-context randomUUID", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const crypto = globalThis.crypto;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { getRandomValues: (value) => crypto.getRandomValues(value) },
  });
  const f = fixture();
  try {
    const captured = f.host.captureContext("test.context/select", view);
    NodeAssert.match(captured.id, /^ctx-[a-f0-9]{32}$/);
  } finally {
    f.host.dispose();
    Object.defineProperty(globalThis, "crypto", original);
  }
});
