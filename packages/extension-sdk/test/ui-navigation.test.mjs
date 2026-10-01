import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import {
  GENERIC_API_CATALOGUE,
  UI_EXTERNAL_OPEN,
  UI_NAVIGATION_OPEN,
  UI_NAVIGATION_OPEN_SESSION,
  uiNavigationApi,
} from "../dist/catalogue.js";
import * as Catalogue from "../dist/catalogue.js";
import { CLIENT_PROVIDER_APIS } from "../dist/clientProviders.js";
import { ApiVersionError, bindApi } from "../dist/capabilities.js";

NodeTest.test("t3.ui/navigation is a shared catalogue contract behind its own grant", () => {
  NodeAssert.ok(GENERIC_API_CATALOGUE.includes(uiNavigationApi.definition));
  const methods = Object.fromEntries(
    uiNavigationApi.definition.methods.map((method) => [method.name, method]),
  );
  NodeAssert.deepEqual(Object.keys(methods).sort(), [
    "getCapabilities",
    "openAgentSession",
    "openFile",
    "openThread",
  ]);
  NodeAssert.deepEqual(methods.openThread.requiredGrants, [UI_NAVIGATION_OPEN]);
  NodeAssert.equal(methods.openThread.effect, "write");
  NodeAssert.deepEqual(methods.getCapabilities.requiredGrants, []);
  NodeAssert.ok(CLIENT_PROVIDER_APIS.has("t3.client/navigation"));
});

NodeTest.test("openThread takes a thread reference, not a URL or route", () => {
  const openThread = uiNavigationApi.definition.methods.find(
    (method) => method.name === "openThread",
  );
  NodeAssert.deepEqual(openThread.inputSchema.required, ["threadId"]);
  NodeAssert.equal(openThread.inputSchema.additionalProperties, false);
  NodeAssert.deepEqual(Object.keys(openThread.inputSchema.properties).sort(), [
    "surfaceId",
    "threadId",
  ]);
  const refused = openThread.outputSchema.oneOf.find(
    (branch) => branch.properties.status.const === "refused",
  );
  NodeAssert.deepEqual(refused.properties.reason.enum, [
    "unknown-thread",
    "out-of-scope",
    "surface-not-found",
  ]);
});

NodeTest.test("openAgentSession names an agent, never a URL, behind its own grant", () => {
  const method = uiNavigationApi.definition.methods.find(
    (candidate) => candidate.name === "openAgentSession",
  );
  NodeAssert.equal(method.effect, "write");
  // Distinct from in-app routing and from the any-URL external opener.
  NodeAssert.deepEqual(method.requiredGrants, [UI_NAVIGATION_OPEN_SESSION]);
  NodeAssert.notEqual(UI_NAVIGATION_OPEN_SESSION, UI_NAVIGATION_OPEN);
  NodeAssert.notEqual(UI_NAVIGATION_OPEN_SESSION, UI_EXTERNAL_OPEN);
  NodeAssert.equal(method.inputSchema.additionalProperties, false);
  NodeAssert.deepEqual(Object.keys(method.inputSchema.properties), ["agentId"]);
  const [opened, refused] = method.outputSchema.oneOf;
  NodeAssert.ok(!("url" in opened.properties));
  NodeAssert.deepEqual(refused.properties.reason.enum, [
    "unknown-thread",
    "unknown-agent",
    "no-session",
    "opener-refused",
  ]);
  const capabilities = uiNavigationApi.definition.methods.find(
    (candidate) => candidate.name === "getCapabilities",
  );
  NodeAssert.ok(
    JSON.stringify(capabilities.outputSchema).includes("openAgentSession"),
    "getCapabilities reports openAgentSession availability",
  );
});

NodeTest.test("openFile names a workspace path on the caller's own thread, never a surface", () => {
  const method = uiNavigationApi.definition.methods.find(
    (candidate) => candidate.name === "openFile",
  );
  NodeAssert.ok(method, "t3.ui/navigation exposes openFile");
  NodeAssert.equal(method.effect, "write");
  NodeAssert.deepEqual(method.requiredGrants, [UI_NAVIGATION_OPEN]);
  NodeAssert.equal(method.inputSchema.additionalProperties, false);
  NodeAssert.deepEqual(method.inputSchema.required, ["relativePath"]);
  // No thread, surface or provider id: the host opens the file where its
  // native links do, through the selected t3.file/presentation provider.
  NodeAssert.deepEqual(Object.keys(method.inputSchema.properties).sort(), [
    "line",
    "openIn",
    "relativePath",
  ]);
  NodeAssert.deepEqual(method.inputSchema.properties.openIn.enum, ["panel", "browser"]);
  const refused = method.outputSchema.oneOf.find(
    (branch) => branch.properties.status.const === "refused",
  );
  NodeAssert.deepEqual(refused.properties.reason.enum, [
    "unknown-thread",
    "out-of-scope",
    "invalid-path",
    "not-previewable",
    "browser-unavailable",
    "open-failed",
  ]);
  const client = CLIENT_PROVIDER_APIS.get("t3.client/navigation").methods.find(
    (candidate) => candidate.name === "openFile",
  );
  NodeAssert.ok(client, "t3.client/navigation backs openFile");
  NodeAssert.deepEqual(client.outputSchema, method.outputSchema);
  const capabilities = uiNavigationApi.definition.methods.find(
    (candidate) => candidate.name === "getCapabilities",
  );
  NodeAssert.ok(JSON.stringify(capabilities.outputSchema).includes("openFile"));
});

NodeTest.test(
  "openWorkspaceFile opens through t3.ui/navigation and refuses unsafe paths locally",
  async () => {
    NodeAssert.equal(typeof Catalogue.openWorkspaceFile, "function");
    const context = { client: "web", resource: { namespace: "ext", id: "ext.a" } };
    const requests = [];
    const client = {
      discoverApis: async () => [{ id: "t3.ui/navigation", version: "1.1.0" }],
      invokeApi: (request) => {
        requests.push(request);
        return Promise.resolve({ status: "opened", relativePath: request.input.relativePath });
      },
    };
    const signal = new AbortController().signal;
    for (const path of ["", "../x", "/etc/passwd", "a//b", "a\\b", "./a", "C:/x"])
      NodeAssert.deepEqual(await Catalogue.openWorkspaceFile(client, context, path, { signal }), {
        status: "refused",
        reason: "invalid-path",
      });
    NodeAssert.equal(requests.length, 0);
    NodeAssert.deepEqual(
      await Catalogue.openWorkspaceFile(client, context, "src/a.ts", { line: 3, signal }),
      { status: "opened", relativePath: "src/a.ts" },
    );
    NodeAssert.deepEqual(
      requests.map(({ id, versionRange, method, input }) => ({ id, versionRange, method, input })),
      [
        {
          id: "t3.ui/navigation",
          versionRange: "^1.1.0",
          method: "openFile",
          input: { relativePath: "src/a.ts", line: 3 },
        },
      ],
    );
    NodeAssert.equal(typeof Catalogue.describeOpenFileRefusal, "function");
    for (const reason of ["unknown-thread", "out-of-scope", "invalid-path"])
      NodeAssert.match(Catalogue.describeOpenFileRefusal(reason), /\S/);
  },
);

// openFile shipped inside the immutable
// 1.0.0. It is a 1.1.0 addition: packs keep loading on a 1.0.0 host and
// probe before they call it.
NodeTest.test("openFile is a 1.1.0 addition over the 1.0.0 baseline", async () => {
  NodeAssert.equal(uiNavigationApi.baseline, "1.0.0");
  const requests = [];
  const client = {
    invokeApi: (request) => {
      requests.push(request);
      return Promise.resolve({ status: "opened", threadId: "t" });
    },
  };
  const context = { client: "web", resource: { namespace: "ext", id: "ext.a" } };
  const signal = new AbortController().signal;
  const baseline = bindApi(uiNavigationApi, client, context);
  await NodeAssert.rejects(
    baseline.invoke("openFile", { relativePath: "a.ts" }, signal),
    (error) => error instanceof ApiVersionError,
  );
  await baseline.invoke("openThread", { threadId: "t" }, signal);
  NodeAssert.deepEqual(
    requests.map(({ method, versionRange }) => ({ method, versionRange })),
    [{ method: "openThread", versionRange: "^1.0.0" }],
  );
});

NodeTest.test("openWorkspaceFile degrades on a host older than 1.1.0", async () => {
  NodeAssert.equal(typeof Catalogue.openWorkspaceFile, "function");
  const requests = [];
  const client = {
    discoverApis: async () => [{ id: "t3.ui/navigation", version: "1.0.0" }],
    invokeApi: (request) => {
      requests.push(request);
      return Promise.resolve({ status: "opened", relativePath: request.input.relativePath });
    },
  };
  const context = { client: "web", resource: { namespace: "ext", id: "ext.a" } };
  NodeAssert.deepEqual(
    await Catalogue.openWorkspaceFile(client, context, "src/a.ts", {
      signal: new AbortController().signal,
    }),
    { status: "refused", reason: "host-unsupported" },
  );
  NodeAssert.equal(requests.length, 0);
  NodeAssert.match(Catalogue.describeOpenFileRefusal("host-unsupported"), /\S/);
});

// A file link's line reaches the selected
// presentation. `open.line` is a 1.1.0 addition; 1.0.0 providers keep matching.
NodeTest.test("t3.file/presentation 1.1.0 adds open.line and keeps 1.0.0 frozen", async () => {
  const { filePresentationApi } = Catalogue;
  NodeAssert.equal(filePresentationApi.definition.version, "1.1.0");
  NodeAssert.equal(filePresentationApi.baseline, "1.0.0");
  const frozen = GENERIC_API_CATALOGUE.find(
    (api) => api.id === "t3.file/presentation" && api.version === "1.0.0",
  );
  NodeAssert.ok(frozen, "the published 1.0.0 stays in the catalogue");
  NodeAssert.deepEqual(Object.keys(frozen.methods[0].inputSchema.properties), ["relativePath"]);
  NodeAssert.doesNotThrow(() => Catalogue.assertProvidedApiOwner("other.plugin", frozen));
  const context = { client: "web", resource: { namespace: "ext", id: "ext.a" } };
  const client = { invokeApi: () => Promise.resolve({}) };
  await NodeAssert.rejects(
    bindApi(filePresentationApi, client, context).invoke(
      "open",
      { relativePath: "a.ts", line: 2 },
      new AbortController().signal,
    ),
    (error) => error instanceof ApiVersionError,
  );
});

// The 1.1.0 bumps must not un-publish 1.0.0.
// The fixture is each definition as published at 1.0.0, dumped from that build.
NodeTest.test(
  "providers of the published 1.0.0 UI and presentation contracts stay valid",
  async () => {
    const { validateEnvironmentPackage } = await import("../dist/environment.js");
    const published = JSON.parse(
      NodeFS.readFileSync(new URL("./fixtures/published-1.0.0-apis.json", import.meta.url), "utf8"),
    );
    const accepted = {};
    for (const [id, definition] of Object.entries(published)) {
      NodeAssert.equal(definition.version, "1.0.0");
      try {
        validateEnvironmentPackage({
          format: 3,
          manifest: { id: "example.provider", version: "1.0.0", apiVersion: 1, surfaces: [] },
          serverEntry: "server.mjs",
          tools: [],
          provides: [definition],
          requires: [],
          dependencies: [],
        });
        accepted[id] = true;
      } catch (error) {
        accepted[id] = error.message;
      }
    }
    NodeAssert.deepEqual(accepted, {
      "t3.ui/navigation": true,
      "t3.ui/preferences": true,
      "t3.file/presentation": true,
      "t3.ui/external": true,
    });
  },
);

// Native parity (FilePreviewPanel "Open file in preview browser"): openFile
// can open a page in the thread's preview browser. It is a 1.2.0 input
// addition, so a pack keeps its 1.0.0 requirement and probes before using it.
NodeTest.test("openIn is a 1.2.0 addition that keeps 1.1.0 frozen", async () => {
  NodeAssert.equal(uiNavigationApi.definition.version, "1.2.0");
  NodeAssert.equal(CLIENT_PROVIDER_APIS.get("t3.client/navigation").version, "1.2.0");
  NodeAssert.deepEqual(
    uiNavigationApi.additions.map(({ version, method, input }) => [version, method, input]),
    [
      ["1.1.0", "openFile", undefined],
      ["1.2.0", "openFile", "openIn"],
    ],
  );
  const frozen = Catalogue.uiNavigationApiV1_1.definition;
  NodeAssert.equal(frozen.version, "1.1.0");
  NodeAssert.ok(GENERIC_API_CATALOGUE.includes(frozen));
  const frozenOpen = frozen.methods.find((method) => method.name === "openFile");
  NodeAssert.deepEqual(Object.keys(frozenOpen.inputSchema.properties).sort(), [
    "line",
    "relativePath",
  ]);
  NodeAssert.deepEqual(frozenOpen.outputSchema.oneOf[1].properties.reason.enum, [
    "unknown-thread",
    "out-of-scope",
    "invalid-path",
  ]);
  const context = { client: "web", resource: { namespace: "ext", id: "ext.a" } };
  const client = { invokeApi: () => Promise.resolve({ status: "opened", relativePath: "a.html" }) };
  const signal = new AbortController().signal;
  await NodeAssert.rejects(
    bindApi(uiNavigationApi, client, context, "^1.1.0").invoke(
      "openFile",
      { relativePath: "a.html", openIn: "browser" },
      signal,
    ),
    (error) => error instanceof ApiVersionError,
  );
});

NodeTest.test("openWorkspaceFile opens a page in the preview browser on a 1.2.0 host", async () => {
  const context = { client: "web", resource: { namespace: "ext", id: "ext.a" } };
  const signal = new AbortController().signal;
  const host = (version) => {
    const requests = [];
    return {
      requests,
      discoverApis: async () => [{ id: "t3.ui/navigation", version }],
      invokeApi: (request) => {
        requests.push(request);
        return Promise.resolve({ status: "opened", relativePath: request.input.relativePath });
      },
    };
  };
  const current = host("1.2.0");
  NodeAssert.deepEqual(
    await Catalogue.openWorkspaceFile(current, context, "site/index.html", {
      openIn: "browser",
      signal,
    }),
    { status: "opened", relativePath: "site/index.html" },
  );
  NodeAssert.deepEqual(
    current.requests.map(({ versionRange, method, input }) => ({ versionRange, method, input })),
    [
      {
        versionRange: "^1.2.0",
        method: "openFile",
        input: { relativePath: "site/index.html", openIn: "browser" },
      },
    ],
  );
  const older = host("1.1.0");
  NodeAssert.deepEqual(
    await Catalogue.openWorkspaceFile(older, context, "site/index.html", {
      openIn: "browser",
      signal,
    }),
    { status: "refused", reason: "host-unsupported" },
  );
  NodeAssert.equal(older.requests.length, 0);
  for (const reason of ["not-previewable", "browser-unavailable", "open-failed"])
    NodeAssert.match(Catalogue.describeOpenFileRefusal(reason), /\S/);
});

// Native offers "Open file in preview
// browser" only on a client that has one; a pack asks the invoking client.
NodeTest.test("canOpenFilesInBrowser asks a 1.2.0 host about the invoking client", async () => {
  const context = { client: "web", resource: { namespace: "ext", id: "ext.a", threadId: "t" } };
  const signal = new AbortController().signal;
  const host = (version, openFileInBrowser) => {
    const requests = [];
    return {
      requests,
      discoverApis: async () => [{ id: "t3.ui/navigation", version }],
      invokeApi: async (request) => {
        requests.push([request.method, request.versionRange]);
        return {
          adapter: "host.ui.navigation",
          operations: {
            openThread: true,
            openAgentSession: true,
            openFile: true,
            openFileInBrowser,
          },
          clients: [],
        };
      },
    };
  };
  const answers = [];
  for (const [version, supported] of [
    ["1.2.0", true],
    ["1.2.0", false],
    ["1.1.0", true],
  ]) {
    const client = host(version, supported);
    answers.push([
      await Catalogue.canOpenFilesInBrowser?.(client, context, signal),
      client.requests,
    ]);
  }
  NodeAssert.deepEqual(answers, [
    [true, [["getCapabilities", "^1.2.0"]]],
    [false, [["getCapabilities", "^1.2.0"]]],
    [false, []],
  ]);
  const capabilities = uiNavigationApi.definition.methods.find((m) => m.name === "getCapabilities");
  NodeAssert.ok(
    capabilities.outputSchema.properties.operations.required.includes("openFileInBrowser"),
  );
  const frozen = Catalogue.uiNavigationApiV1_1.definition.methods.find(
    (m) => m.name === "getCapabilities",
  );
  NodeAssert.ok(!frozen.outputSchema.properties.operations.required.includes("openFileInBrowser"));
});
