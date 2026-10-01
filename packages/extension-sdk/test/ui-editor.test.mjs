import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as Catalogue from "../dist/catalogue.js";
const { GENERIC_API_CATALOGUE, UI_EDITOR_OPEN, uiEditorApi, uiEditorApiV1 } = Catalogue;
import { bindApi } from "../dist/capabilities.js";
import { CLIENT_PROVIDER_APIS } from "../dist/clientProviders.js";

NodeTest.test("t3.ui/editor is a shared catalogue contract behind its own grant", () => {
  NodeAssert.ok(GENERIC_API_CATALOGUE.includes(uiEditorApi.definition));
  NodeAssert.equal(uiEditorApi.definition.version, "1.1.0");
  const methods = Object.fromEntries(
    uiEditorApi.definition.methods.map((method) => [method.name, method]),
  );
  NodeAssert.deepEqual(methods.openPath.requiredGrants, [UI_EDITOR_OPEN]);
  NodeAssert.equal(methods.openPath.effect, "write");
  NodeAssert.deepEqual(methods.getCapabilities.requiredGrants, []);
  NodeAssert.ok(CLIENT_PROVIDER_APIS.has("t3.client/editor"));
  NodeAssert.equal(CLIENT_PROVIDER_APIS.get("t3.client/editor").version, "1.1.0");
});

NodeTest.test(
  "workspace input is minor-version guarded and the published baseline stays frozen",
  async () => {
    NodeAssert.equal(uiEditorApi.baseline, "1.0.0");
    NodeAssert.deepEqual(uiEditorApi.additions, [
      { version: "1.1.0", method: "openPath", input: "workspace" },
      { version: "1.1.0", method: "openPath", output: "url" },
      { version: "1.1.0", method: "openPath", input: "editor" },
      { version: "1.1.0", method: "openPath", input: "hintShown" },
      { version: "1.1.0", method: "getCapabilities", output: "editor" },
    ]);
    NodeAssert.ok(GENERIC_API_CATALOGUE.includes(uiEditorApiV1.definition));
    const oldOpen = uiEditorApiV1.definition.methods.find(({ name }) => name === "openPath");
    NodeAssert.deepEqual(oldOpen.inputSchema.required, ["path", "cwd"]);
    NodeAssert.equal(oldOpen.outputSchema.oneOf[0].properties.url, undefined);
    const context = {
      resource: { namespace: "test", id: "editor", environmentId: "env" },
      client: "web",
    };
    const calls = [];
    const client = {
      invokeApi: async (request) => {
        calls.push(request);
        return { status: "opened", path: "/ws/a.ts", editor: "vscode" };
      },
    };
    await NodeAssert.rejects(
      bindApi(uiEditorApi, client, context).invoke("openPath", { path: "a.ts", workspace: true }),
      /1\.1\.0/,
    );
    NodeAssert.equal(calls.length, 0);
    await bindApi(uiEditorApi, client, context, "^1.1.0").invoke("openPath", {
      path: "a.ts",
      workspace: true,
    });
    NodeAssert.deepEqual(calls[0].input, { path: "a.ts", workspace: true });
  },
);
