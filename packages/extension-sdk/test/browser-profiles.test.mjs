import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { browserProfilesApi, GENERIC_API_CATALOGUE } from "../dist/catalogue.js";
import { bindApi } from "../dist/capabilities.js";

const context = {
  client: "web",
  resource: { namespace: "example.browser-profiles", id: "view", environmentId: "env" },
};

NodeTest.test("the install UI can offer each profile grant from the generic catalogue", () => {
  NodeAssert.ok(GENERIC_API_CATALOGUE.includes(browserProfilesApi.definition));
  const grants = new Set(
    browserProfilesApi.definition.methods.flatMap((method) => method.requiredGrants),
  );
  for (const grant of [
    "t3.browser/profiles",
    "t3.browser/clear-cookies",
    "t3.browser/clear-cache",
    "t3.browser/import-cookies",
  ]) {
    NodeAssert.ok(grants.has(grant), grant);
  }
});

NodeTest.test(
  "a clear through the typed facade names the profile and returns the host's outcome",
  async () => {
    const controller = new AbortController();
    const api = bindApi(
      browserProfilesApi,
      {
        async invokeApi(request, signal) {
          NodeAssert.equal(request.id, "t3.browser/profiles");
          NodeAssert.equal(request.versionRange, "^1.0.0");
          NodeAssert.equal(request.method, "clearCookies");
          NodeAssert.deepEqual(request.input, { profileId: "work" });
          NodeAssert.equal(signal, controller.signal);
          return { outcome: "cleared", profileId: "work" };
        },
      },
      context,
    );
    NodeAssert.deepEqual(
      await api.invoke("clearCookies", { profileId: "work" }, controller.signal),
      {
        outcome: "cleared",
        profileId: "work",
      },
    );
  },
);

NodeTest.test("1.1.0 adds the changes stream while default consumers stay on ^1.0.0", async () => {
  const { requireApi } = await import("../dist/authoring.js");
  const { browserProfilesApiV1 } = await import("../dist/catalogue.js");
  NodeAssert.equal(browserProfilesApi.definition.version, "1.1.0");
  NodeAssert.deepEqual(requireApi(browserProfilesApi), {
    id: "t3.browser/profiles",
    versionRange: "^1.0.0",
  });
  NodeAssert.deepEqual(
    browserProfilesApi.definition.streams.map((stream) => [stream.name, stream.requiredGrants]),
    [["changes", ["t3.browser/profiles"]]],
  );
  // 1.0.0 stays in the catalogue, frozen, so providers built on it still match.
  NodeAssert.ok(GENERIC_API_CATALOGUE.includes(browserProfilesApiV1.definition));
  NodeAssert.equal(browserProfilesApiV1.definition.version, "1.0.0");
  NodeAssert.equal(browserProfilesApiV1.definition.streams, undefined);
});

NodeTest.test("the changes stream needs a binding that guarantees 1.1.0", async () => {
  const { ApiVersionError, bindStreamApi } = await import("../dist/capabilities.js");
  const requests = [];
  const client = {
    subscribeApi(request) {
      requests.push(request);
      return (async function* () {})();
    },
  };
  const signal = new AbortController().signal;
  // The default ^1.0.0 range admits a host without the stream: refused unprobed.
  NodeAssert.throws(
    () => bindStreamApi(browserProfilesApi, client, context).subscribe("changes", {}, signal),
    (error) => error instanceof ApiVersionError && /needs \^1\.1\.0/.test(error.message),
  );
  NodeAssert.deepEqual(requests, []);
  bindStreamApi(browserProfilesApi, client, context, "^1.1.0").subscribe("changes", {}, signal);
  NodeAssert.deepEqual(
    requests.map(({ id, versionRange, name }) => ({ id, versionRange, name })),
    [{ id: "t3.browser/profiles", versionRange: "^1.1.0", name: "changes" }],
  );
});
