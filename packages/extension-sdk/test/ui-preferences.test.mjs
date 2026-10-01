import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import {
  GENERIC_API_CATALOGUE,
  UI_PREFERENCES,
  UI_PREFERENCES_API,
  UI_PREFERENCES_READ,
  UI_PREFERENCES_WRITE,
  assertProvidedApiOwner,
} from "../dist/catalogue.js";
import { ApiVersionError, bindApi, validateApiDefinition } from "../dist/capabilities.js";
import * as Catalogue from "../dist/catalogue.js";
import { uiPreferencesApi } from "../dist/catalogue.js";
import { CLIENT_PREFERENCES_API, CLIENT_PROVIDER_APIS } from "../dist/clientProviders.js";

NodeTest.test("t3.ui/preferences is a canonical catalogue contract", () => {
  NodeAssert.equal(UI_PREFERENCES_API.id, UI_PREFERENCES);
  NodeAssert.ok(GENERIC_API_CATALOGUE.includes(UI_PREFERENCES_API));
  NodeAssert.deepEqual(validateApiDefinition(UI_PREFERENCES_API), UI_PREFERENCES_API);
  NodeAssert.doesNotThrow(() => assertProvidedApiOwner("other.plugin", UI_PREFERENCES_API));
  NodeAssert.equal(CLIENT_PROVIDER_APIS.get("t3.client/preferences"), CLIENT_PREFERENCES_API);
});

NodeTest.test("reads and the change stream need read; only the write needs write", () => {
  const grants = Object.fromEntries(
    [...UI_PREFERENCES_API.methods, ...UI_PREFERENCES_API.streams].map((operation) => [
      operation.name,
      { effect: operation.effect, grants: operation.requiredGrants },
    ]),
  );
  NodeAssert.deepEqual(grants, {
    getCapabilities: { effect: "read", grants: [] },
    getPreferences: { effect: "read", grants: [UI_PREFERENCES_READ] },
    setPreferences: { effect: "write", grants: [UI_PREFERENCES_WRITE] },
    subscribePreferences: { effect: undefined, grants: [UI_PREFERENCES_READ] },
  });
});

NodeTest.test("the public read and receipt share the client area's typed shape", () => {
  const publicMethods = Object.fromEntries(UI_PREFERENCES_API.methods.map((m) => [m.name, m]));
  const clientMethods = Object.fromEntries(CLIENT_PREFERENCES_API.methods.map((m) => [m.name, m]));
  NodeAssert.deepEqual(
    publicMethods.getPreferences.outputSchema,
    clientMethods.getPreferences.outputSchema,
  );
  NodeAssert.deepEqual(
    publicMethods.setPreferences.outputSchema,
    clientMethods.applyPreferences.outputSchema,
  );
  NodeAssert.deepEqual(
    publicMethods.setPreferences.inputSchema,
    clientMethods.applyPreferences.inputSchema.properties.patch,
  );
  // Closed shapes: unknown keys are not silently accepted as preferences.
  NodeAssert.equal(publicMethods.setPreferences.inputSchema.additionalProperties, false);
  NodeAssert.equal(publicMethods.getPreferences.outputSchema.additionalProperties, false);
});

NodeTest.test("renderBrowserFile is an optional boolean so older hosts stay valid", () => {
  const publicMethods = Object.fromEntries(UI_PREFERENCES_API.methods.map((m) => [m.name, m]));
  const read = publicMethods.getPreferences.outputSchema;
  NodeAssert.deepEqual(read.properties.renderBrowserFile, { type: "boolean" });
  // A host that predates the key still answers { wordWrap } alone.
  NodeAssert.deepEqual(read.required, ["wordWrap"]);
  NodeAssert.deepEqual(publicMethods.setPreferences.inputSchema.properties.renderBrowserFile, {
    type: "boolean",
  });
});

// renderBrowserFile shipped inside the
// immutable 1.0.0. It is a 1.1.0 addition over a 1.0.0 baseline, and the
// client seam moves with it.
NodeTest.test("renderBrowserFile is a 1.1.0 addition over the 1.0.0 baseline", async () => {
  NodeAssert.equal(uiPreferencesApi.baseline, "1.0.0");
  const requests = [];
  const client = {
    invokeApi: (request) => {
      requests.push(request);
      return Promise.resolve({ applied: true, preferences: { wordWrap: true } });
    },
  };
  const context = { client: "web", resource: { namespace: "ext", id: "ext.a" } };
  const signal = new AbortController().signal;
  const baseline = bindApi(uiPreferencesApi, client, context);
  await NodeAssert.rejects(
    baseline.invoke("setPreferences", { renderBrowserFile: false }, signal),
    (error) => error instanceof ApiVersionError,
  );
  await baseline.invoke("setPreferences", { wordWrap: true }, signal);
  await bindApi(uiPreferencesApi, client, context, "^1.1.0").invoke(
    "setPreferences",
    { renderBrowserFile: false },
    signal,
  );
  NodeAssert.deepEqual(
    requests.map(({ versionRange, input }) => ({ versionRange, input })),
    [
      { versionRange: "^1.0.0", input: { wordWrap: true } },
      { versionRange: "^1.1.0", input: { renderBrowserFile: false } },
    ],
  );
});

// The Files explorer choice is the native
// panel's shared one — a 1.2.0 key over the published 1.1.0, which stays frozen.
NodeTest.test("fileExplorerOpen is a 1.2.0 addition; 1.1.0 stays frozen", async () => {
  NodeAssert.equal(UI_PREFERENCES_API.version, "1.2.0");
  NodeAssert.equal(CLIENT_PREFERENCES_API.version, "1.2.0");
  const read = UI_PREFERENCES_API.methods.find((m) => m.name === "getPreferences").outputSchema;
  NodeAssert.deepEqual(read.properties.fileExplorerOpen, { type: "boolean" });
  NodeAssert.deepEqual(read.required, ["wordWrap"]);
  const frozen = Catalogue.uiPreferencesApiV1_1?.definition;
  NodeAssert.equal(frozen?.version, "1.1.0");
  NodeAssert.ok(GENERIC_API_CATALOGUE.includes(frozen));
  for (const method of frozen.methods.filter((m) => m.name !== "getCapabilities")) {
    const schema = method.name === "setPreferences" ? method.inputSchema : method.outputSchema;
    const properties = schema.properties.preferences?.properties ?? schema.properties;
    NodeAssert.deepEqual(Object.keys(properties).sort(), ["renderBrowserFile", "wordWrap"]);
  }
  const requests = [];
  const client = {
    invokeApi: (request) => {
      requests.push(request);
      return Promise.resolve({ applied: true, preferences: { wordWrap: true } });
    },
  };
  const context = { client: "web", resource: { namespace: "ext", id: "ext.a" } };
  const signal = new AbortController().signal;
  await NodeAssert.rejects(
    bindApi(uiPreferencesApi, client, context, "^1.1.0").invoke(
      "setPreferences",
      { fileExplorerOpen: false },
      signal,
    ),
    (error) => error instanceof ApiVersionError,
  );
  await bindApi(uiPreferencesApi, client, context, "^1.2.0").invoke(
    "setPreferences",
    { fileExplorerOpen: false },
    signal,
  );
  NodeAssert.deepEqual(
    requests.map(({ versionRange, input }) => ({ versionRange, input })),
    [{ versionRange: "^1.2.0", input: { fileExplorerOpen: false } }],
  );
});
