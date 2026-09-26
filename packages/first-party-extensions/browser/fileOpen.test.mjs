import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import {
  FOREIGN_ORIGIN_UNREACHABLE,
  fileLeaseRef,
  fileOpenErrorState,
  mintGate,
  mintWorkspaceFileUrl,
  resolveLeaseUrl,
} from "./fileOpen.ts";
import { isLeaseUrl } from "./viewModel.ts";

const TOKEN_URL = "/api/assets/eyJ2.sig/index.html";

NodeTest.describe("fileLeaseRef", () => {
  NodeTest.it("builds a workspace-file ref for a workspace HTML path", () => {
    NodeAssert.deepEqual(fileLeaseRef("thread-1", "site/index.html"), {
      ok: true,
      resource: { _tag: "workspace-file", threadId: "thread-1", path: "site/index.html" },
    });
  });

  NodeTest.it("refuses paths outside the workspace before minting", () => {
    for (const path of [
      "/etc/passwd.html",
      "../up.html",
      "a/../../b.html",
      "C:/x.html",
      "a\\b.html",
      "",
    ])
      NodeAssert.equal(fileLeaseRef("thread-1", path).reason, "outside-workspace", path);
  });

  NodeTest.it("names non-browser files and a missing thread", () => {
    NodeAssert.equal(fileLeaseRef("thread-1", "src/app.ts").reason, "not-previewable");
    NodeAssert.equal(fileLeaseRef(undefined, "index.html").reason, "context-missing");
  });
});

NodeTest.describe("resolveLeaseUrl", () => {
  NodeTest.it("resolves the server-relative URL on the document origin", () => {
    NodeAssert.deepEqual(resolveLeaseUrl(TOKEN_URL, "http://100.64.0.2:3773/#/env/thread"), {
      ok: true,
      url: "http://100.64.0.2:3773/api/assets/eyJ2.sig/index.html",
    });
  });

  NodeTest.it("names a non-HTTP document (the desktop renderer) as foreign origin", () => {
    const result = resolveLeaseUrl(TOKEN_URL, "t3code://app/#/env/thread");
    NodeAssert.equal(result.ok, false);
    NodeAssert.equal(result.reason, "foreign-origin");
    NodeAssert.match(result.message, /t3code:\/\/app/);
  });

  NodeTest.it("names an absolute URL on another origin and a missing base", () => {
    NodeAssert.equal(
      resolveLeaseUrl("https://elsewhere.test/api/assets/x/a.html", "http://localhost:3773/")
        .reason,
      "foreign-origin",
    );
    NodeAssert.equal(resolveLeaseUrl(TOKEN_URL, undefined).reason, "foreign-origin");
  });
});

NodeTest.describe("mintGate + fileOpenErrorState", () => {
  NodeTest.it("an absent workspace-file kind is mint-unsupported", () => {
    NodeAssert.equal(mintGate(["workspace-file", "browser-surface"]), null);
    NodeAssert.equal(mintGate(["project-favicon"]).reason, "mint-unsupported");
  });

  NodeTest.it("maps each adapter denial to its named reason", () => {
    const cases = [
      ["ResourceLeaseGrantDeniedError: grant 't3.workspace/resources' is required", "grant-denied"],
      ["ResourceLeaseKindDeniedError: kind 'workspace-file' is not mintable", "mint-unsupported"],
      ["AssetWorkspacePathValidationError", "outside-workspace"],
      ["AssetPreviewTypeValidationError", "not-previewable"],
      ["AssetWorkspaceAssetNotFoundError", "not-found"],
      ["AssetWorkspaceContextNotFoundError", "context-missing"],
      ["API unavailable", "mint-unsupported"],
      ["socket closed", "unavailable"],
    ];
    for (const [message, reason] of cases)
      NodeAssert.equal(fileOpenErrorState(new Error(message)).reason, reason, message);
    NodeAssert.match(
      fileOpenErrorState(new Error("ResourceLeaseGrantDeniedError")).message,
      /t3\.workspace\/resources/,
    );
  });
});

const lease = (overrides = {}) => {
  const calls = [];
  return {
    calls,
    getCapabilities: async () => {
      calls.push("getCapabilities");
      return { supportedKinds: ["workspace-file"] };
    },
    createPresentationUrl: async (resource) => {
      calls.push(["createPresentationUrl", resource]);
      return { url: TOKEN_URL, expiresAt: 1_700_000_000_000, kind: "workspace-file" };
    },
    ...overrides,
  };
};
const okFetch = async () => new Response("<html></html>", { status: 200 });

NodeTest.describe("mintWorkspaceFileUrl", () => {
  const base = {
    threadId: "thread-1",
    relativePath: "site/index.html",
    documentUrl: "http://127.0.0.1:3773/",
    signal: new AbortController().signal,
  };

  NodeTest.it("mints, resolves and preflights on the environment origin", async () => {
    const api = lease();
    const fetched = [];
    const result = await mintWorkspaceFileUrl({
      ...base,
      lease: api,
      fetch: async (url) => {
        fetched.push(url);
        return okFetch();
      },
    });
    NodeAssert.deepEqual(result, {
      ok: true,
      url: "http://127.0.0.1:3773/api/assets/eyJ2.sig/index.html",
      expiresAt: 1_700_000_000_000,
    });
    NodeAssert.deepEqual(api.calls, [
      "getCapabilities",
      [
        "createPresentationUrl",
        { _tag: "workspace-file", threadId: "thread-1", path: "site/index.html" },
      ],
    ]);
    NodeAssert.deepEqual(fetched, [result.url]);
  });

  NodeTest.it("a foreign-origin client never mints", async () => {
    const api = lease();
    const result = await mintWorkspaceFileUrl({
      ...base,
      documentUrl: "t3code://app/",
      lease: api,
      fetch: okFetch,
    });
    NodeAssert.equal(result.reason, "foreign-origin");
    NodeAssert.deepEqual(api.calls, []);
  });

  NodeTest.it("a preflight miss is foreign origin, not an engine 404 page", async () => {
    const miss = await mintWorkspaceFileUrl({
      ...base,
      lease: lease(),
      fetch: async () => new Response("", { status: 404 }),
    });
    NodeAssert.deepEqual(miss, {
      ok: false,
      reason: "foreign-origin",
      message: FOREIGN_ORIGIN_UNREACHABLE,
    });
    const thrown = await mintWorkspaceFileUrl({
      ...base,
      lease: lease(),
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    NodeAssert.equal(thrown.reason, "foreign-origin");
  });

  NodeTest.it("names grant denial, unsupported kinds and outside-workspace paths", async () => {
    const denied = await mintWorkspaceFileUrl({
      ...base,
      lease: lease({
        createPresentationUrl: async () => {
          throw new Error("ResourceLeaseGrantDeniedError: grant 't3.workspace/resources'");
        },
      }),
      fetch: okFetch,
    });
    NodeAssert.equal(denied.reason, "grant-denied");
    const unsupported = await mintWorkspaceFileUrl({
      ...base,
      lease: lease({ getCapabilities: async () => ({ supportedKinds: [] }) }),
      fetch: okFetch,
    });
    NodeAssert.equal(unsupported.reason, "mint-unsupported");
    const outside = await mintWorkspaceFileUrl({
      ...base,
      relativePath: "../secrets.html",
      lease: lease(),
      fetch: okFetch,
    });
    NodeAssert.equal(outside.reason, "outside-workspace");
  });

  NodeTest.it("rethrows an abort instead of reporting a state", async () => {
    const controller = new AbortController();
    await NodeAssert.rejects(
      mintWorkspaceFileUrl({
        ...base,
        signal: controller.signal,
        lease: lease({
          getCapabilities: async () => {
            controller.abort();
            throw new Error("aborted");
          },
        }),
        fetch: okFetch,
      }),
    );
  });
});

NodeTest.describe("isLeaseUrl", () => {
  NodeTest.it("recognizes minted asset URLs so history never keeps them", () => {
    NodeAssert.equal(isLeaseUrl("http://127.0.0.1:3773/api/assets/tok/index.html"), true);
    NodeAssert.equal(isLeaseUrl("http://localhost:5173/"), false);
    NodeAssert.equal(isLeaseUrl("not a url"), false);
  });
});
