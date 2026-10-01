import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import * as NodeCrypto from "node:crypto";
import React from "react";
import TestRenderer from "react-test-renderer";

import { EditableFileBody, ReadOnlyFileBody } from "./codeView.ts";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act, create } = TestRenderer;
const e = React.createElement;

function codeViewHost() {
  const received = [];
  const File = (props) => {
    received.push(props);
    return e("div", { "data-host-file": true });
  };
  return { host: { codeView: { version: 1, Diff: () => null, File } }, received };
}

async function render(props) {
  const calls = [];
  let root;
  await act(async () => {
    root = create(
      e(ReadOnlyFileBody, {
        path: "big.log",
        contents: "line 1\nline 2\n",
        wordWrap: null,
        reveal: null,
        renderFallback: () => {
          calls.push("fallback");
          return e("pre", { "data-own-pre": true });
        },
        ...props,
      }),
    );
  });
  return { root, calls };
}

NodeTest.describe("ReadOnlyFileBody", () => {
  NodeTest.it("keeps the own <pre> on hosts without the member", async () => {
    const { root, calls } = await render({ host: {} });
    NodeAssert.deepEqual(calls, ["fallback"]);
    NodeAssert.equal(root.root.findAll((node) => node.props["data-own-pre"]).length, 1);
  });

  NodeTest.it("keeps the own <pre> when the member is malformed", async () => {
    const { calls } = await render({ host: { codeView: { version: 1, File: () => null } } });
    NodeAssert.deepEqual(calls, ["fallback"]);
  });

  NodeTest.it("renders the host File when the member is present", async () => {
    const { host, received } = codeViewHost();
    const { root, calls } = await render({ host });
    NodeAssert.deepEqual(calls, []);
    NodeAssert.equal(root.root.findAll((node) => node.props["data-own-pre"]).length, 0);
    // No preference available: the host's own wrap setting applies.
    NodeAssert.deepEqual(received.at(-1), { path: "big.log", contents: "line 1\nline 2\n" });
  });

  NodeTest.it("forwards the panel's wrap preference and a pending reveal", async () => {
    const { host, received } = codeViewHost();
    await render({ host, wordWrap: false, reveal: { line: 2, requestId: 7 } });
    NodeAssert.deepEqual(received.at(-1), {
      path: "big.log",
      contents: "line 1\nline 2\n",
      wordWrap: false,
      reveal: { line: 2, requestId: 7 },
    });
  });
});

NodeTest.describe("EditableFileBody", () => {
  NodeTest.it(
    "mounts the available editor immediately without discovery or a read-only mount",
    async () => {
      const requests = [];
      const mounts = [];
      const host = {
        codeView: {
          version: 1,
          Diff: () => null,
          File: () => {
            mounts.push("read-only");
            return e("pre");
          },
          Editor: () => {
            mounts.push("editor");
            return e("div", { "data-editor": true });
          },
        },
        async discoverApis() {
          requests.push("discover");
          throw new Error("offline");
        },
        async invokeApi() {
          requests.push("invoke");
          throw new Error("offline");
        },
      };
      let root;
      try {
        await act(async () => {
          root = create(
            e(EditableFileBody, {
              host,
              session: { context: {}, signal: new AbortController().signal },
              documentId: "app.ts",
              path: "app.ts",
              contents: "old",
              wordWrap: null,
              reveal: null,
              onChange() {},
              renderFallback: () => e("pre"),
            }),
          );
        });
        NodeAssert.deepEqual(mounts, ["editor"]);
        NodeAssert.deepEqual(requests, []);
        NodeAssert.equal(root.root.findAllByProps({ role: "status" }).length, 0);
      } finally {
        if (root) await act(async () => root.unmount());
      }
    },
  );
  NodeTest.it("keeps old or unsupported clients read-only, never a textarea", async () => {
    for (const host of [{}, codeViewHost().host]) {
      let root;
      await act(async () => {
        root = create(
          e(EditableFileBody, {
            host,
            documentId: "project:app.ts",
            path: "app.ts",
            contents: "old",
            session: { signal: new AbortController().signal, context: {} },
            wordWrap: null,
            reveal: null,
            onChange() {},
            onSelectionChange() {},
            renderFallback: () => e("pre", {}, "old"),
          }),
        );
      });
      NodeAssert.equal(root.root.findAllByType("textarea").length, 0);
      NodeAssert.equal(
        root.root.findAllByType("pre").length +
          root.root.findAll((node) => node.props["data-host-file"]).length,
        1,
      );
      await act(async () => root.unmount());
    }
  });

  NodeTest.it("saves the host editor's actual edit through the Files CAS session", async () => {
    const { useFileEditor } = await import("./editorSession.ts");
    const saves = [];
    let finishSave;
    const saved = new Promise((resolve) => {
      finishSave = resolve;
    });
    let latest;
    const session = {
      context: { resource: { environmentId: "env", projectId: "project" } },
      signal: new AbortController().signal,
    };
    const host = {
      codeView: {
        version: 1,
        Diff: () => null,
        File: () => null,
        Editor: (props) => {
          latest = props;
          return e("div", { "data-editor": true });
        },
      },
      async invokeApi(request) {
        if (request.method === "readSnapshot")
          return { kind: "editable", contents: "old", revision: "base" };
        if (request.method === "save") {
          saves.push(request.input);
          finishSave();
          return { kind: "saved", revision: "next" };
        }
        throw new Error(request.method);
      },
    };
    function Harness() {
      const editor = useFileEditor(host, session, "app.ts", "text", 0, true);
      if (!editor.surface?.open.editable) return null;
      return e(EditableFileBody, {
        host,
        session,
        documentId: "project:app.ts",
        path: "app.ts",
        contents: editor.surface.contents,
        wordWrap: false,
        reveal: { line: 2, requestId: 7 },
        onChange: editor.change,
        onSelectionChange() {},
        renderFallback: () => e("pre"),
      });
    }
    let root;
    await act(async () => {
      root = create(e(Harness));
    });
    NodeAssert.equal(root.root.findAllByType("textarea").length, 0);
    NodeAssert.deepEqual(latest.reveal, { line: 2, requestId: 7 });
    await act(async () => latest.onChange("edited"));
    await act(async () => saved);
    NodeAssert.deepEqual(saves, [
      { relativePath: "app.ts", contents: "edited", expectedRevision: "base" },
    ]);
    await act(async () => root.unmount());
  });

  NodeTest.it(
    "routes large editor buffers through chunked CAS and preserves conflicts until recovery",
    async () => {
      const { useFileEditor } = await import("./editorSession.ts");
      const digest = (text) => NodeCrypto.createHash("sha256").update(text).digest("hex");
      let disk = "disk\n".repeat(6000);
      let upload;
      let chunks;
      let conflict = true;
      let finishConflict;
      const conflicted = new Promise((resolve) => {
        finishConflict = resolve;
      });
      let latest;
      let controls;
      const begins = [];
      let finishRecovery;
      const recovery = new Promise((resolve) => {
        finishRecovery = resolve;
      });
      const host = {
        codeView: {
          version: 1,
          Diff: () => null,
          File: () => null,
          Editor: (props) => {
            latest = props;
            return e("div");
          },
        },
        async invokeApi(request) {
          const { method, input } = request;
          if (method === "readSnapshot") return { kind: "not-editable", reason: "oversized" };
          if (method === "save") throw new Error("large buffers must use resources");
          if (method === "save.begin") {
            begins.push(input);
            upload = input;
            chunks = [];
            return { kind: "session", uploadId: "upload" };
          }
          if (method === "save.chunk") {
            chunks[input.chunkIndex] = input.data;
            return { kind: "accepted" };
          }
          if (method === "save.commit") {
            const contents = chunks.join("");
            NodeAssert.equal(Buffer.byteLength(contents), upload.byteLength);
            NodeAssert.equal(digest(contents), upload.sha256);
            NodeAssert.equal(chunks.length, upload.chunkCount);
            if (conflict) {
              disk = "remote\n".repeat(5000);
              finishConflict();
              return { kind: "conflict" };
            }
            NodeAssert.equal(upload.expectedRevision, digest(disk));
            disk = contents;
            finishRecovery();
            return { kind: "saved", revision: digest(disk) };
          }
          throw new Error(method);
        },
        async *subscribeApi() {
          const contents = disk;
          yield {
            value: {
              kind: "manifest",
              relativePath: "big.ts",
              byteLength: Buffer.byteLength(contents),
              deliveredByteLength: Buffer.byteLength(contents),
              chunkCount: 1,
              truncated: false,
            },
          };
          yield { value: { kind: "chunk", chunkIndex: 0, data: contents } };
          yield { value: { kind: "complete", sha256: digest(contents) } };
        },
      };
      const session = { context: { resource: {} }, signal: new AbortController().signal };
      function Harness() {
        const editor = useFileEditor(host, session, "big.ts", "text", 0, true);
        React.useEffect(() => {
          controls = editor;
        }, [editor]);
        if (!editor.surface?.open.editable) return null;
        return e(EditableFileBody, {
          host,
          session,
          documentId: "big.ts",
          path: "big.ts",
          contents: editor.surface.contents,
          wordWrap: false,
          reveal: null,
          onChange: editor.change,
          renderFallback: () => e("pre"),
        });
      }
      let root;
      try {
        await act(async () => {
          root = create(e(Harness));
        });
        const mine = "edited Ω\n".repeat(5000);
        await act(async () => latest.onChange(mine));
        NodeAssert.equal(controls.surface.saveState.kind, "dirty");
        await act(async () => conflicted);
        NodeAssert.equal(controls.surface.saveState.kind, "conflict");
        await act(async () => {
          latest.onChange(mine + "kept");
        });
        NodeAssert.equal(begins.length, 1);
        NodeAssert.equal(controls.surface.contents, mine + "kept");
        conflict = false;
        await act(async () => {
          controls.keepMine();
          await recovery;
        });
        NodeAssert.equal(begins.length, 2);
        NodeAssert.equal(disk, mine + "kept");
        NodeAssert.equal(controls.surface.saveState.kind, "saved");
      } finally {
        if (root) await act(async () => root.unmount());
      }
    },
  );
});
