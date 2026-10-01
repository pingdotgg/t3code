import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";
import React from "react";
import { bindApi, defineApi } from "../dist/capabilities.js";
import { requireApi } from "../dist/authoring.js";
import * as Catalogue from "../dist/catalogue.js";

/**
 * Every catalogue API whose default range sits above its major's x.0.0. Every
 * pack that calls `requireApi(api)` or `bindApi(api, …)` without a range gets
 * this floor, so a minor bump that moves it stops loading those packs on older
 * hosts. Add `baseline` when the new members are optional; change this table
 * only when every default consumer really needs the new floor.
 */
const RAISED_DEFAULT_FLOORS = {
  browserHistoryApi: "^1.1.0",
  browserSessionsApi: "^1.2.0",
  browserSessionsApiV1_1: "^1.1.0",
  composerContextApi: "^1.2.0",
  messagesEnrichmentApi: "^1.1.0",
  messagesEnrichmentApiV1_1: "^1.1.0",
  orchestrationControlApi: "^1.1.0",
  prsReadApiV1_1: "^1.1.0",
  resourcesLeaseApi: "^1.1.0",
  terminalSessionsApi: "^1.1.0",
  textEditsApi: "^1.1.0",
  uiKeybindingsApi: "^1.1.0",
  vcsChangesApi: "^1.1.0",
  vcsDiffApi: "^1.1.0",
  vcsRepositoryApi: "^1.2.0",
  vcsRepositoryApiV1_1: "^1.1.0",
};

NodeTest.test("a catalogue minor bump never silently raises default requirements", () => {
  const raised = Object.fromEntries(
    Object.entries(Catalogue)
      .filter(([, value]) => typeof value?.definition?.id === "string")
      .map(([name, api]) => [name, requireApi(api).versionRange])
      .filter(([, range]) => !/^\^\d+\.0\.0$/.test(range)),
  );
  NodeAssert.deepEqual(raised, RAISED_DEFAULT_FLOORS);
});

NodeTest.test("notifications 1.1 keeps default consumers on ^1.0.0", () => {
  NodeAssert.equal(Catalogue.uiNotificationsApi.definition.version, "1.1.0");
  NodeAssert.deepEqual(requireApi(Catalogue.uiNotificationsApi), {
    id: "t3.ui/notifications",
    versionRange: "^1.0.0",
  });
});

NodeTest.test("a baseline must be an earlier version of the same major", () => {
  const definition = { ...Catalogue.uiPanelsApi.definition, version: "1.2.3" };
  const additions = [{ version: "1.2.3", method: definition.methods[1].name, input: "title" }];
  const range = (baseline) =>
    requireApi(
      defineApi(
        definition,
        baseline === definition.version ? { baseline } : { baseline, additions },
      ),
    ).versionRange;
  NodeAssert.equal(range("1.0.0"), "^1.0.0");
  NodeAssert.equal(range("1.2.3"), "^1.2.3");
  for (const baseline of ["1.3.0", "1.2.4", "0.9.0", "2.0.0", "^1.0.0", "1.0"])
    NodeAssert.throws(() => defineApi(definition, { baseline, additions }), /baseline/, baseline);
});

const context = {
  client: "web",
  resource: { namespace: "t3.extensions", id: "ext.a", environmentId: "env", projectId: "p" },
};
const recordingClient = () => {
  const requests = [];
  return {
    requests,
    invokeApi: async (request) => {
      requests.push(request);
      return request.method === "notify" ? { notificationId: "n" } : { applied: true };
    },
  };
};
const keepOpenNotify = {
  severity: "success",
  title: "Capture",
  actions: [{ id: "copy", label: "Copy", keepOpen: true }],
};
const flashUpdate = {
  notificationId: "n",
  flashAction: { actionId: "copy", label: "Copied!", durationMs: 2000 },
};

NodeTest.test("a default binding refuses members newer than its baseline", async () => {
  const client = recordingClient();
  const notifications = bindApi(Catalogue.uiNotificationsApi, client, context);
  for (const [method, input] of [
    ["notify", keepOpenNotify],
    ["update", flashUpdate],
  ])
    await NodeAssert.rejects(notifications.invoke(method, input, AbortSignal.timeout(1000)), {
      name: "ApiVersionError",
      code: "api-version-not-negotiated",
      message: new RegExp(`t3\\.ui/notifications#${method} .* needs \\^1\\.1\\.0`),
    });
  NodeAssert.deepEqual(client.requests, []);
  // Members every 1.x host takes still go through at the baseline range.
  await notifications.invoke(
    "notify",
    { severity: "info", title: "Plain", actions: [{ id: "open", label: "Open" }] },
    AbortSignal.timeout(1000),
  );
  NodeAssert.deepEqual(
    client.requests.map((request) => request.versionRange),
    ["^1.0.0"],
  );
});

NodeTest.test("a binding at the newer range sends those members", async () => {
  for (const range of ["^1.1.0", "~1.1.0", ">=1.1.0 <2.0.0", "1.1.0"]) {
    const client = recordingClient();
    const notifications = bindApi(Catalogue.uiNotificationsApi, client, context, range);
    await notifications.invoke("notify", keepOpenNotify, AbortSignal.timeout(1000));
    await notifications.invoke("update", flashUpdate, AbortSignal.timeout(1000));
    NodeAssert.equal(client.requests.length, 2, range);
  }
  // A range the SDK cannot bound from below stays refused.
  const loose = bindApi(Catalogue.uiNotificationsApi, recordingClient(), context, "1.x || ^1.1.0");
  await NodeAssert.rejects(loose.invoke("notify", keepOpenNotify, AbortSignal.timeout(1000)), {
    name: "ApiVersionError",
  });
});

NodeTest.test("a baseline below the current version must name what it added", () => {
  const definition = { ...Catalogue.uiPanelsApi.definition, version: "1.2.0" };
  NodeAssert.throws(() => defineApi(definition, { baseline: "1.0.0" }), /additions/);
  const method = definition.methods[1].name;
  for (const additions of [
    [{ version: "1.0.0", method, input: "title" }],
    [{ version: "1.3.0", method, input: "title" }],
    [{ version: "1.1.0", method: "nope", input: "title" }],
    [{ version: "1.1.0", method, input: "" }],
  ])
    NodeAssert.throws(() => defineApi(definition, { baseline: "1.0.0", additions }), /addition/);
  defineApi(definition, {
    baseline: "1.0.0",
    additions: [{ version: "1.1.0", method, input: "title" }],
  });
});

NodeTest.test(
  "a built pack cannot ship an unprobed 1.1.0 call on a ^1.0.0 requirement",
  async () => {
    const sdk = NodeURL.fileURLToPath(new URL("..", import.meta.url));
    const dir = await NodeFSP.mkdtemp(NodePath.join(sdk, ".tmp-unprobed-"));
    try {
      await NodeFSP.cp(NodePath.join(sdk, "test/fixtures/notifications-unprobed"), dir, {
        recursive: true,
      });
      const build = NodeChildProcess.spawnSync(
        process.execPath,
        [NodePath.join(sdk, "bin/t3-extension.mjs"), "build", dir],
        { encoding: "utf8" },
      );
      NodeAssert.equal(build.status, 0, build.stderr || build.stdout);
      const built = JSON.parse(
        await NodeFSP.readFile(NodePath.join(dir, ".t3-extension/t3-extension.json"), "utf8"),
      );
      NodeAssert.deepEqual(built.requires, [{ id: "t3.ui/notifications", versionRange: "^1.0.0" }]);
      const { default: factory } = await import(
        NodeURL.pathToFileURL(NodePath.join(dir, ".t3-extension/client.mjs")).href
      );
      const client = recordingClient();
      const pack = factory({ React, invokeApi: client.invokeApi });
      pack.surfaces[0].createView({ context, signal: AbortSignal.timeout(1000) });
      await NodeAssert.rejects(globalThis.unprobedNotify, { name: "ApiVersionError" });
      NodeAssert.deepEqual(client.requests, []);
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  },
);

NodeTest.test("a baseline needs plain X.Y.Z versions throughout", () => {
  const additions = [{ version: "1.1.0", method: "notify", input: "actions[].keepOpen" }];
  const define = (version, baseline, added = additions) =>
    defineApi(
      { ...Catalogue.uiNotificationsApi.definition, version },
      { baseline, additions: added },
    );
  for (const version of ["1.1.0+build.1", "1.2.0-rc.1"])
    NodeAssert.throws(() => define(version, "1.0.0"), /plain X\.Y\.Z version/, version);
  for (const baseline of ["1.0.0-0", "1.0.0+build.1"])
    NodeAssert.throws(() => define("1.1.0", baseline), /plain X\.Y\.Z version/, baseline);
  for (const version of ["1.1.0-0", "1.1.0+build.1", "1.0.9007199254740992"])
    NodeAssert.throws(
      () => define("1.1.0", "1.0.0", [{ ...additions[0], version }]),
      /plain X\.Y\.Z version/,
      version,
    );
  // A definition without a baseline keeps any version the schema accepts.
  defineApi({ ...Catalogue.uiNotificationsApi.definition, version: "1.2.0-rc.1" });
});

NodeTest.test("a large patch below the adding minor does not guarantee it", async () => {
  for (const range of [">=1.0.20260927", "^1.0.20260927", "~1.0.99999999999999999999"]) {
    const client = recordingClient();
    const notifications = bindApi(Catalogue.uiNotificationsApi, client, context, range);
    await NodeAssert.rejects(
      notifications.invoke("notify", keepOpenNotify, AbortSignal.timeout(1000)),
      { name: "ApiVersionError" },
      range,
    );
    NodeAssert.deepEqual(client.requests, [], range);
  }
});

// Ranges that previously reached members they did not declare.
NodeTest.test("a prerelease range never dispatches a member added at its release", async () => {
  // Prereleases cannot be declared, so the 0.0.0-0 baseline is gone; an
  // exact 0.0.0-0 binding is refused rather than floored at 0.0.0.
  NodeAssert.throws(
    () =>
      defineApi(
        { ...Catalogue.uiNotificationsApi.definition, id: "review.zero", version: "0.0.0" },
        {
          baseline: "0.0.0-0",
          additions: [{ version: "0.0.0", method: "notify", input: "title" }],
        },
      ),
    /plain X\.Y\.Z version/,
  );
  for (const range of ["0.0.0-0", ">=1.1.0-0", "^1.1.0-rc.1", "1.1.0+build.1"]) {
    const client = recordingClient();
    await NodeAssert.rejects(
      bindApi(Catalogue.uiNotificationsApi, client, context, range).invoke(
        "notify",
        keepOpenNotify,
        AbortSignal.timeout(1000),
      ),
      { name: "ApiVersionError" },
      range,
    );
    NodeAssert.deepEqual(client.requests, [], range);
  }
});

NodeTest.test("a huge prerelease identifier cannot declare or bind an addition", async () => {
  NodeAssert.throws(
    () =>
      defineApi(
        { ...Catalogue.uiNotificationsApi.definition, id: "review.big", version: "1.1.0" },
        {
          baseline: "1.0.0",
          additions: [
            { version: "1.1.0-9007199254740993", method: "notify", input: "actions[].keepOpen" },
          ],
        },
      ),
    /plain X\.Y\.Z version/,
  );
  const client = recordingClient();
  const notifications = bindApi(
    Catalogue.uiNotificationsApi,
    client,
    context,
    ">=1.1.0-9007199254740992",
  );
  await NodeAssert.rejects(
    notifications.invoke("notify", keepOpenNotify, AbortSignal.timeout(1000)),
    { name: "ApiVersionError" },
  );
  NodeAssert.deepEqual(client.requests, []);
  // Members every 1.x host takes still pass the range through untouched.
  await notifications.invoke(
    "notify",
    { severity: "info", title: "Plain" },
    AbortSignal.timeout(1000),
  );
  NodeAssert.deepEqual(
    client.requests.map((request) => request.versionRange),
    [">=1.1.0-9007199254740992"],
  );
});

NodeTest.test("a stream addition must name one of the API's streams", () => {
  const definition = {
    id: "example.test/streams",
    version: "1.1.0",
    methods: [],
    streams: [{ name: "changes", requiredGrants: [], inputSchema: {}, eventSchema: {} }],
  };
  const define = (stream) =>
    defineApi(definition, { baseline: "1.0.0", additions: [{ version: "1.1.0", stream }] });
  NodeAssert.doesNotThrow(() => define("changes"));
  NodeAssert.equal(define("changes").baseline, "1.0.0");
  NodeAssert.throws(() => define("missing"), /Invalid API addition/);
});
