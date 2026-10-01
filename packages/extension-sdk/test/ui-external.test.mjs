import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import {
  checkExternalUrl,
  GENERIC_API_CATALOGUE,
  UI_EXTERNAL_OPEN,
  uiExternalApi,
} from "../dist/catalogue.js";
import * as Catalogue from "../dist/catalogue.js";
import { CLIENT_PROVIDER_APIS } from "../dist/clientProviders.js";

NodeTest.test("t3.ui/external is a shared catalogue contract behind its own grant", () => {
  NodeAssert.ok(GENERIC_API_CATALOGUE.includes(uiExternalApi.definition));
  const methods = Object.fromEntries(
    uiExternalApi.definition.methods.map((method) => [method.name, method]),
  );
  NodeAssert.deepEqual(methods.open.requiredGrants, [UI_EXTERNAL_OPEN]);
  NodeAssert.equal(methods.open.effect, "write");
  NodeAssert.deepEqual(methods.getCapabilities.requiredGrants, []);
  NodeAssert.ok(CLIENT_PROVIDER_APIS.has("t3.client/external"));
});

NodeTest.test("checkExternalUrl admits absolute http(s) and normalizes to href", () => {
  NodeAssert.deepEqual(checkExternalUrl("https://Example.com"), {
    ok: true,
    url: "https://example.com/",
  });
  NodeAssert.deepEqual(checkExternalUrl("http://localhost:5173/a?b=1#c"), {
    ok: true,
    url: "http://localhost:5173/a?b=1#c",
  });
});

NodeTest.test("checkExternalUrl refuses relative input and every other scheme", () => {
  for (const value of ["", "example.com", "/path", "//example.com", "http://"])
    NodeAssert.deepEqual(checkExternalUrl(value), { ok: false, reason: "invalid-url" }, value);
  for (const value of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<p>x</p>",
    "mailto:a@example.com",
    "vscode://vscode-remote/ssh-remote+host/path",
    "ftp://example.com",
  ])
    NodeAssert.deepEqual(
      checkExternalUrl(value),
      { ok: false, reason: "scheme-not-allowed" },
      value,
    );
});

// Terminal URL links ignored "Open links in: in-app browser" because
// the only surface was the OS opener. `openLink` is a 1.1.0 addition where
// the host, not the pack, applies the setting.
NodeTest.test("openLink is a 1.1.0 addition over a frozen 1.0.0", async () => {
  const { uiExternalApiV1 } = Catalogue;
  NodeAssert.equal(uiExternalApi.definition.version, "1.1.0");
  NodeAssert.equal(uiExternalApi.baseline, "1.0.0");
  NodeAssert.deepEqual(
    uiExternalApi.additions.map(({ version, method }) => [version, method]),
    [["1.1.0", "openLink"]],
  );
  const openLink = uiExternalApi.definition.methods.find((method) => method.name === "openLink");
  NodeAssert.deepEqual(openLink.requiredGrants, [UI_EXTERNAL_OPEN]);
  NodeAssert.deepEqual(Object.keys(openLink.inputSchema.properties).sort(), ["forceSystem", "url"]);
  NodeAssert.deepEqual(openLink.outputSchema.oneOf[0].properties.opener.enum, [
    "desktop-shell",
    "browser-window",
    "in-app-browser",
  ]);
  // The published 1.0.0 stays in the catalogue, unchanged.
  const published = JSON.parse(
    NodeFS.readFileSync(new URL("./fixtures/published-1.0.0-apis.json", import.meta.url), "utf8"),
  );
  NodeAssert.deepEqual(uiExternalApiV1.definition, published["t3.ui/external"]);
  NodeAssert.equal(uiExternalApiV1.definition.version, "1.0.0");
  NodeAssert.ok(GENERIC_API_CATALOGUE.includes(uiExternalApiV1.definition));
  NodeAssert.deepEqual(
    uiExternalApiV1.definition.methods.map((method) => method.name),
    ["getCapabilities", "open"],
  );
  NodeAssert.deepEqual(
    uiExternalApiV1.definition.methods[1].outputSchema.oneOf[0].properties.opener.enum,
    ["desktop-shell", "browser-window"],
  );
  // The private area carries it at 1.1.0 too.
  const client = CLIENT_PROVIDER_APIS.get("t3.client/external");
  NodeAssert.equal(client.version, "1.1.0");
  NodeAssert.ok(client.methods.some((method) => method.name === "openLink"));
});

NodeTest.test("openExternalLink asks a 1.1.0 host to route the link", async () => {
  const context = { client: "desktop", resource: { namespace: "ext", id: "ext.a" } };
  const signal = new AbortController().signal;
  const run = async (version, forceSystem) => {
    const requests = [];
    const client = {
      discoverApis: async () => [{ id: "t3.ui/external", version }],
      invokeApi: (request) => {
        requests.push(request);
        return Promise.resolve({
          status: "opened",
          url: request.input.url,
          opener: "in-app-browser",
        });
      },
    };
    await Catalogue.openExternalLink(client, context, "https://t3.codes/", {
      ...(forceSystem === undefined ? {} : { forceSystem }),
      signal,
    });
    return requests.map(({ id, versionRange, method, input }) => ({
      id,
      versionRange,
      method,
      input,
    }));
  };
  NodeAssert.deepEqual(await run("1.1.0"), [
    {
      id: "t3.ui/external",
      versionRange: "^1.1.0",
      method: "openLink",
      input: { url: "https://t3.codes/" },
    },
  ]);
  NodeAssert.deepEqual(await run("1.1.0", true), [
    {
      id: "t3.ui/external",
      versionRange: "^1.1.0",
      method: "openLink",
      input: { url: "https://t3.codes/", forceSystem: true },
    },
  ]);
  // An older host has no setting-aware open: the system browser, as before.
  NodeAssert.deepEqual(await run("1.0.0"), [
    {
      id: "t3.ui/external",
      versionRange: "^1.0.0",
      method: "open",
      input: { url: "https://t3.codes/" },
    },
  ]);
});
