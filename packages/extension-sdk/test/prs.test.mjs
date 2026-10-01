import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import { bindApi, bindStreamApi, defineApi } from "../dist/capabilities.js";
import { requireApi } from "../dist/authoring.js";
import * as Catalogue from "../dist/catalogue.js";

// Read through the namespace: a catalogue without the 1.0.0 freeze fails the
// assertions below rather than the import.
const {
  assertProvidedApiOwner,
  GENERIC_API_CATALOGUE,
  PRS_READ,
  PRS_READ_API,
  PRS_READ_API_V1,
  prsReadApi,
  prsReadApiV1,
  prsReadApiV1_1,
} = Catalogue;

const methods = Object.fromEntries(PRS_READ_API.methods.map((m) => [m.name, m]));
const streams = Object.fromEntries((PRS_READ_API.streams ?? []).map((s) => [s.name, s]));

const canonical = (value) =>
  Array.isArray(value)
    ? "[" + value.map(canonical).join(",") + "]"
    : value && typeof value === "object"
      ? "{" +
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, child]) => JSON.stringify(key) + ":" + canonical(child))
          .join(",") +
        "}"
      : JSON.stringify(value);

NodeTest.test(
  "t3.prs/read 1.2.0 is registered beside its frozen 1.0.0 and 1.1.0 definitions",
  () => {
    NodeAssert.equal(PRS_READ_API.id, PRS_READ);
    NodeAssert.equal(PRS_READ_API.version, "1.2.0");
    NodeAssert.equal(prsReadApi.definition, PRS_READ_API);
    NodeAssert.equal(PRS_READ_API_V1.version, "1.0.0");
    NodeAssert.equal(prsReadApiV1.definition, PRS_READ_API_V1);
    NodeAssert.deepEqual(
      GENERIC_API_CATALOGUE.filter((d) => d.id === PRS_READ),
      [PRS_READ_API, prsReadApiV1_1.definition, PRS_READ_API_V1],
    );
    // The published 1.0.0 contract, byte for byte (canonical form).
    NodeAssert.equal(
      NodeCrypto.createHash("sha256").update(canonical(PRS_READ_API_V1)).digest("hex"),
      "623bee3fe260c832aa7fd77d7ba570122d13f347b0f89d2b701d769955bce6d3",
    );
  },
);

NodeTest.test("a provider still registering the published 1.0.0 descriptor is accepted", () => {
  const published = structuredClone(PRS_READ_API_V1);
  NodeAssert.doesNotThrow(() => assertProvidedApiOwner("host.prs", published));
  NodeAssert.doesNotThrow(() => assertProvidedApiOwner("host.prs", PRS_READ_API));
});

NodeTest.test(
  "viewed pages can identify the complete snapshot without changing index cursors",
  () => {
    NodeAssert.deepEqual(methods.filesViewed.outputSchema.properties.snapshot, {
      type: "string",
      minLength: 64,
      maxLength: 64,
      pattern: "^[a-f0-9]{64}$",
    });
    NodeAssert.equal(methods.filesViewed.outputSchema.required.includes("snapshot"), false);
    NodeAssert.equal(
      methods.filesViewed.inputSchema.properties.cursor.pattern,
      "^[1-9][0-9]{0,2}$",
    );
  },
);

NodeTest.test("viewed state has its own negotiated read, leaving detail unchanged", () => {
  const detail = methods.detail.outputSchema;
  NodeAssert.ok("viewedFiles" in detail.properties.capabilities.properties);
  NodeAssert.equal(detail.properties.capabilities.required.includes("viewedFiles"), false);
  for (const output of ["filesViewed", "filesViewedError"]) {
    NodeAssert.equal(output in detail.properties, false);
  }
  NodeAssert.ok(
    prsReadApi.additions.some(
      (addition) =>
        addition.version === "1.2.0" &&
        addition.method === "filesViewed" &&
        addition.output === undefined,
    ),
  );
  NodeAssert.equal(
    methods.filesViewed.outputSchema.properties.files.items.properties.path.maxLength,
    4096,
  );
  NodeAssert.ok(methods.filesViewed.outputSchema.required.includes("nextCursor"));
  NodeAssert.ok("filesViewedOnly" in methods.invalidate.inputSchema.properties);
  NodeAssert.ok(
    "prs.filesViewed" in methods.getCapabilities.outputSchema.properties.operations.properties,
  );
  const published = prsReadApiV1_1.definition.methods.find(
    (method) => method.name === "detail",
  ).outputSchema;
  NodeAssert.equal("filesViewed" in published.properties, false);
  NodeAssert.equal("viewedFiles" in published.properties.capabilities.properties, false);
  NodeAssert.deepEqual(requireApi(prsReadApi), { id: PRS_READ, versionRange: "^1.0.0" });
});

NodeTest.test(
  "viewed reads and cache invalidation negotiate 1.2.0 without raising old reads",
  async () => {
    const calls = [];
    const client = {
      invokeApi: async (request) => {
        calls.push(request);
        return {};
      },
    };
    const context = { resource: { namespace: "test", id: "test", projectId: "p" }, client: "web" };
    const signal = new AbortController().signal;
    const ref = { repository: "o/r", number: 3 };
    await NodeAssert.rejects(
      bindApi(prsReadApi, client, context).invoke("filesViewed", ref, signal),
      /needs \^1\.2\.0/,
    );
    await NodeAssert.rejects(
      bindApi(prsReadApi, client, context).invoke(
        "invalidate",
        { reference: ref, filesViewedOnly: true },
        signal,
      ),
      /needs \^1\.2\.0/,
    );
    NodeAssert.equal(calls.length, 0);
    await bindApi(prsReadApi, client, context, "^1.2.0").invoke("filesViewed", ref, signal);
    await bindApi(prsReadApi, client, context).invoke("detail", ref, signal);
    NodeAssert.deepEqual(
      calls.map((call) => call.versionRange),
      ["^1.2.0", "^1.0.0"],
    );
  },
);

NodeTest.test("1.1.0 only adds optional outputs, so default consumers stay on ^1.0.0", async () => {
  for (const [method, member] of [
    ["detail", "preferredMergeMethod"],
    ["detail", "observedAt"],
  ]) {
    const schema = methods[method].outputSchema;
    NodeAssert.ok(member in schema.properties, member);
    NodeAssert.equal(schema.required.includes(member), false, member);
  }
  const entry = methods.list.outputSchema.properties.entries.items;
  NodeAssert.ok("observedAt" in entry.properties);
  NodeAssert.equal(entry.required.includes("observedAt"), false);

  NodeAssert.deepEqual(requireApi(prsReadApi), { id: PRS_READ, versionRange: "^1.0.0" });
  const context = {
    client: "web",
    resource: { namespace: "t3.extensions", id: "ext.a", environmentId: "env", projectId: "p" },
  };
  const requests = [];
  const client = {
    invokeApi: async (request) => {
      requests.push(request);
      // A 1.0.0 host answers without the 1.1.0 members.
      return { number: 3 };
    },
    subscribeApi: (request) => {
      requests.push(request);
      return (async function* () {})();
    },
  };
  const detail = await bindApi(prsReadApi, client, context).invoke(
    "detail",
    { repository: "o/r", number: 3 },
    new AbortController().signal,
  );
  NodeAssert.equal(detail.preferredMergeMethod, undefined);
  bindStreamApi(prsReadApi, client, context).subscribe(
    "subscribeRefreshes",
    {},
    new AbortController().signal,
  );
  NodeAssert.deepEqual(
    requests.map((request) => request.versionRange),
    ["^1.0.0", "^1.0.0"],
  );
});

NodeTest.test("an output addition must name a method or stream of the API", () => {
  const definition = { ...PRS_READ_API, version: "1.2.0" };
  NodeAssert.throws(
    () =>
      defineApi(definition, {
        baseline: "1.0.0",
        additions: [{ version: "1.2.0", method: "missing", output: "x" }],
      }),
    /Invalid API addition/,
  );
  NodeAssert.doesNotThrow(() =>
    defineApi(definition, {
      baseline: "1.0.0",
      additions: [{ version: "1.2.0", method: "subscribeRefreshes", output: "kind" }],
    }),
  );
});

NodeTest.test("every operation is read-effected and rides the single t3.prs/read grant", () => {
  NodeAssert.deepEqual(Object.keys(methods).sort(), [
    "activity",
    "detail",
    "filesViewed",
    "getCapabilities",
    "invalidate",
    "labelCandidates",
    "linkedThreads",
    "list",
    "listStats",
    "reviewerCandidates",
    "stack",
    "summary",
    "threadComments",
  ]);
  for (const method of Object.values(methods)) {
    NodeAssert.equal(method.effect, "read", method.name);
    NodeAssert.deepEqual(method.requiredGrants, [PRS_READ], method.name);
    NodeAssert.equal(method.inputSchema.additionalProperties, false, method.name);
  }
  NodeAssert.deepEqual(Object.keys(streams).sort(), [
    "streamDiff",
    "streamDiffFileContents",
    "subscribeRefreshes",
  ]);
  for (const stream of Object.values(streams)) {
    NodeAssert.deepEqual(stream.requiredGrants, [PRS_READ], stream.name);
    NodeAssert.equal(stream.inputSchema.additionalProperties, false, stream.name);
  }
});

NodeTest.test("list is bounded and cannot widen scope: no projectIds in the public input", () => {
  const input = methods.list.inputSchema;
  NodeAssert.equal("projectIds" in input.properties, false);
  NodeAssert.equal("projectId" in input.properties, false);
  NodeAssert.equal(input.properties.limit.maximum, 50);
  NodeAssert.equal(input.properties.cursors.maxProperties, 100);
  NodeAssert.equal(input.properties.query.maxLength, 200);

  const output = methods.list.outputSchema;
  for (const key of ["viewers", "providers", "entries", "errors", "truncated", "nextCursors"]) {
    NodeAssert.ok(output.required.includes(key), key);
  }
  NodeAssert.equal(output.properties.entries.maxItems, 100);
});

NodeTest.test(
  "getCapabilities reports hosted flag, probe detail, and per-operation support",
  () => {
    const output = methods.getCapabilities.outputSchema;
    NodeAssert.deepEqual([...output.required].sort(), [
      "detail",
      "hosted",
      "operations",
      "providers",
      "reason",
    ]);
    NodeAssert.deepEqual(output.properties.reason.enum, [
      "cli-missing",
      "cli-unauthenticated",
      "provider-unsupported",
      null,
    ]);
    const operations = output.properties.operations;
    for (const key of [
      "prs.list",
      "prs.detail",
      "prs.activity",
      "prs.streamDiff",
      "prs.linkedThreads",
      "prs.subscribeRefreshes",
    ]) {
      NodeAssert.equal(operations.properties[key].type, "boolean", key);
    }
  },
);

NodeTest.test("truncation is disclosed on every capped collection result", () => {
  const comments = methods.threadComments.outputSchema;
  NodeAssert.ok(comments.required.includes("truncated"));
  NodeAssert.equal(comments.properties.truncated.type, "boolean");
  const linked = methods.linkedThreads.outputSchema;
  NodeAssert.ok(linked.required.includes("truncated"));
  NodeAssert.equal(linked.properties.truncated.type, "boolean");
});

NodeTest.test("streamDiff frames a whole patch under the vcs 1.1.0 frame family", () => {
  const stream = streams.streamDiff;
  const kinds = stream.eventSchema.oneOf.map((variant) => variant.properties.kind.const);
  NodeAssert.deepEqual(kinds, ["manifest", "chunk", "complete"]);
  const manifest = stream.eventSchema.oneOf[0];
  NodeAssert.equal(manifest.properties.diffHash.pattern, "^[0-9a-f]{64}$");
  NodeAssert.equal(manifest.properties.chunkCount.maximum, 512);
  const chunk = stream.eventSchema.oneOf[1];
  NodeAssert.equal(chunk.properties.data.maxLength, 8192);
  NodeAssert.equal(chunk.properties.chunkIndex.maximum, 511);
  const complete = stream.eventSchema.oneOf[2];
  NodeAssert.equal(complete.properties.payloadSha256.pattern, "^[0-9a-f]{64}$");
});

NodeTest.test("streamDiffFileContents reuses the vcs file-contents frame schema", () => {
  const stream = streams.streamDiffFileContents;
  const kinds = stream.eventSchema.oneOf.map((variant) => variant.properties.kind.const);
  NodeAssert.deepEqual(kinds, ["manifest", "chunk", "complete"]);
  const chunk = stream.eventSchema.oneOf[1];
  NodeAssert.deepEqual(chunk.properties.side.enum, ["old", "new"]);
  const input = stream.inputSchema;
  NodeAssert.deepEqual(input.properties.changeType.enum, [
    "change",
    "rename-pure",
    "rename-changed",
    "new",
    "deleted",
  ]);
});

NodeTest.test("subscribeRefreshes emits refreshed events and a named close", () => {
  const stream = streams.subscribeRefreshes;
  const kinds = stream.eventSchema.oneOf.map((variant) => variant.properties.kind.const);
  NodeAssert.deepEqual(kinds, ["refreshed", "closed"]);
  NodeAssert.deepEqual(stream.eventSchema.oneOf[1].properties.reason.enum, [
    "overflow",
    "refresh-error",
  ]);
});
