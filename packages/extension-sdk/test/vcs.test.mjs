import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import {
  GENERIC_API_CATALOGUE,
  VCS_CHANGES,
  VCS_CHANGES_API,
  VCS_DIFF,
  VCS_DIFF_API,
  VCS_DIFF_API_V1,
  VCS_MUTATE,
  VCS_READ,
  VCS_REFS,
  VCS_REFS_API,
  VCS_REPOSITORY,
  VCS_REPOSITORY_API,
  VCS_REPOSITORY_API_V1,
  VCS_STATUS,
  VCS_STATUS_API,
  vcsChangesApi,
  vcsDiffApi,
  vcsDiffApiV1,
  vcsRefsApi,
  vcsRepositoryApi,
  vcsRepositoryApiV1,
  vcsStatusApi,
} from "../dist/catalogue.js";

const defs = {
  [VCS_STATUS]: VCS_STATUS_API,
  [VCS_REFS]: VCS_REFS_API,
  [VCS_CHANGES]: VCS_CHANGES_API,
  [VCS_DIFF]: VCS_DIFF_API,
  [VCS_REPOSITORY]: VCS_REPOSITORY_API,
};
const apis = {
  [VCS_STATUS]: vcsStatusApi,
  [VCS_REFS]: vcsRefsApi,
  [VCS_CHANGES]: vcsChangesApi,
  [VCS_DIFF]: vcsDiffApi,
  [VCS_REPOSITORY]: vcsRepositoryApi,
};
const methodsOf = (definition) =>
  Object.fromEntries((definition.methods ?? []).map((m) => [m.name, m]));

NodeTest.test(
  "t3.vcs/* contracts are catalogue entries, each registered per frozen version",
  () => {
    for (const [id, definition] of Object.entries(defs)) {
      NodeAssert.equal(definition.id, id);
      NodeAssert.equal(apis[id].definition, definition);
    }
    // t3.vcs/diff and t3.vcs/repository carry additive 1.1.0 entries with the
    // shipped 1.0.0 frozen alongside; every other t3.vcs id is a single
    // frozen 1.0.0 entry.
    for (const id of [VCS_STATUS, VCS_REFS, VCS_CHANGES]) {
      NodeAssert.equal(defs[id].version, "1.0.0");
      NodeAssert.deepEqual(
        GENERIC_API_CATALOGUE.filter((d) => d.id === id),
        [defs[id]],
      );
    }
    NodeAssert.equal(defs[VCS_DIFF].version, "1.1.0");
    NodeAssert.equal(VCS_DIFF_API_V1.version, "1.0.0");
    NodeAssert.equal(vcsDiffApiV1.definition, VCS_DIFF_API_V1);
    NodeAssert.deepEqual(
      GENERIC_API_CATALOGUE.filter((d) => d.id === VCS_DIFF),
      [VCS_DIFF_API, VCS_DIFF_API_V1],
    );
    // The frozen 1.0.0 keeps the shipped methods byte-identical. The deepEqual
    // alone would pass trivially — V1 and 1.1.0 share the same method object
    // references — so the V1 surface is also pinned by content hash.
    NodeAssert.deepEqual(VCS_DIFF_API_V1.methods, defs[VCS_DIFF].methods);
    NodeAssert.equal(
      NodeCrypto.createHash("sha256").update(JSON.stringify(VCS_DIFF_API_V1.methods)).digest("hex"),
      "58f9db9d4fbeefe7a2a9d9391770507ec763acd1448fba1c9436cc5e284bb50b",
    );
    NodeAssert.equal(VCS_DIFF_API_V1.streams, undefined);

    NodeAssert.equal(defs[VCS_REPOSITORY].version, "1.1.0");
    NodeAssert.equal(VCS_REPOSITORY_API_V1.version, "1.0.0");
    NodeAssert.equal(vcsRepositoryApiV1.definition, VCS_REPOSITORY_API_V1);
    NodeAssert.deepEqual(
      GENERIC_API_CATALOGUE.filter((d) => d.id === VCS_REPOSITORY),
      [VCS_REPOSITORY_API, VCS_REPOSITORY_API_V1],
    );
    // The frozen 1.0.0 repository surface is the five shipped methods —
    // getCapabilities with the 16-key operations map, pull, init, and the
    // two worktree methods — pinned by content hash.
    NodeAssert.deepEqual(Object.keys(methodsOf(VCS_REPOSITORY_API_V1)).sort(), [
      "createWorktree",
      "getCapabilities",
      "init",
      "pull",
      "removeWorktree",
    ]);
    NodeAssert.equal(
      NodeCrypto.createHash("sha256")
        .update(JSON.stringify(VCS_REPOSITORY_API_V1.methods))
        .digest("hex"),
      "d72a4271c789fdb5b344ecab35923d0ae1f8891a56b846eae170181b34f97c9d",
    );
  },
);

NodeTest.test("reads ride t3.vcs/read and mutations ride the distinct t3.vcs/mutate grant", () => {
  const expectations = {
    [VCS_STATUS]: { get: "read", refresh: "read" },
    [VCS_REFS]: { list: "read", create: "write", switch: "write" },
    [VCS_CHANGES]: { list: "read", stage: "write", unstage: "write", commit: "write" },
    [VCS_DIFF]: { getPreview: "read", getFileContents: "read" },
    [VCS_REPOSITORY]: {
      getCapabilities: "read",
      pull: "write",
      init: "write",
      createWorktree: "write",
      removeWorktree: "write",
      push: "write",
      fetch: "write",
      listRemotes: "read",
    },
  };
  for (const [id, methods] of Object.entries(expectations)) {
    const byName = methodsOf(defs[id]);
    NodeAssert.deepEqual(Object.keys(byName).sort(), Object.keys(methods).sort());
    for (const [name, effect] of Object.entries(methods)) {
      NodeAssert.equal(byName[name].effect, effect, `${id}.${name}`);
      NodeAssert.deepEqual(
        byName[name].requiredGrants,
        [effect === "read" ? VCS_READ : VCS_MUTATE],
        `${id}.${name}`,
      );
    }
  }
});

NodeTest.test("the status stream is read-granted and carries snapshot/update/closed frames", () => {
  const streams = Object.fromEntries((VCS_STATUS_API.streams ?? []).map((s) => [s.name, s]));
  NodeAssert.deepEqual(Object.keys(streams), ["subscribe"]);
  NodeAssert.deepEqual(streams.subscribe.requiredGrants, [VCS_READ]);
  const kinds = streams.subscribe.eventSchema.oneOf.map((variant) => variant.properties.kind.const);
  NodeAssert.deepEqual(kinds, ["snapshot", "localUpdated", "remoteUpdated", "closed"]);
});

NodeTest.test(
  "the diff streams are read-granted, chunked under the frame envelope, and hash-terminated",
  () => {
    const streams = Object.fromEntries((VCS_DIFF_API.streams ?? []).map((s) => [s.name, s]));
    NodeAssert.deepEqual(Object.keys(streams).sort(), ["streamFileContents", "streamPreview"]);
    for (const stream of Object.values(streams)) {
      NodeAssert.deepEqual(stream.requiredGrants, [VCS_READ], stream.name);
      NodeAssert.equal(stream.inputSchema.additionalProperties, false, stream.name);
    }
    // Stream inputs are byte-identical to the unary method inputs.
    const methods = methodsOf(VCS_DIFF_API);
    NodeAssert.deepEqual(streams.streamPreview.inputSchema, methods.getPreview.inputSchema);
    NodeAssert.deepEqual(
      streams.streamFileContents.inputSchema,
      methods.getFileContents.inputSchema,
    );

    const previewKinds = streams.streamPreview.eventSchema.oneOf.map(
      (variant) => variant.properties.kind.const,
    );
    NodeAssert.deepEqual(previewKinds, ["manifest", "chunk", "complete"]);
    const manifest = streams.streamPreview.eventSchema.oneOf[0];
    NodeAssert.equal(manifest.properties.sources.maxItems, 8);
    NodeAssert.equal(manifest.properties.sources.items.properties.chunkCount.maximum, 64);
    NodeAssert.equal(
      manifest.properties.sources.items.properties.diffHash.pattern,
      "^[0-9a-f]{64}$",
    );
    const previewChunk = streams.streamPreview.eventSchema.oneOf[1];
    // 8192 UTF-16 units per chunk: worst-case JSON escaping (6 bytes/unit)
    // stays under the broker's 64 KiB frame limit with room for frame metadata.
    NodeAssert.equal(previewChunk.properties.data.maxLength, 8192);
    NodeAssert.equal(previewChunk.properties.chunkIndex.maximum, 63);
    NodeAssert.equal(previewChunk.properties.sourceIndex.maximum, 7);
    const previewComplete = streams.streamPreview.eventSchema.oneOf[2];
    NodeAssert.equal(previewComplete.properties.payloadSha256.pattern, "^[0-9a-f]{64}$");

    const contentsKinds = streams.streamFileContents.eventSchema.oneOf.map(
      (variant) => variant.properties.kind.const,
    );
    NodeAssert.deepEqual(contentsKinds, ["manifest", "chunk", "complete"]);
    const contentsManifest = streams.streamFileContents.eventSchema.oneOf[0];
    // Surrogate-straddling boundaries shrink chunks to 8 191 units, so the
    // worst case at the 1 MiB bound is ceil(1 048 576 / 8 191) = 129.
    NodeAssert.equal(contentsManifest.properties.oldChunkCount.maximum, 129);
    NodeAssert.equal(contentsManifest.properties.newChunkCount.maximum, 129);
    const contentsChunk = streams.streamFileContents.eventSchema.oneOf[1];
    NodeAssert.equal(contentsChunk.properties.data.maxLength, 8192);
    NodeAssert.deepEqual(contentsChunk.properties.side.enum, ["old", "new"]);
    NodeAssert.equal(contentsChunk.properties.chunkIndex.maximum, 128);
  },
);

NodeTest.test("changes.list exposes honest per-path staging state", () => {
  const entry = methodsOf(defs[VCS_CHANGES]).list.outputSchema.properties.entries.items;
  NodeAssert.deepEqual([...entry.required].sort(), [
    "conflicted",
    "path",
    "staged",
    "unstaged",
    "untracked",
  ]);
  NodeAssert.equal(entry.properties.path.maxLength, 512);
  const list = methodsOf(defs[VCS_CHANGES]).list.outputSchema;
  NodeAssert.equal(list.properties.entries.maxItems, 5000);
  NodeAssert.equal(list.required.includes("truncated"), true);
});

NodeTest.test("input schemas are closed and bounded", () => {
  const changes = methodsOf(defs[VCS_CHANGES]);
  const refs = methodsOf(defs[VCS_REFS]);
  const repository = methodsOf(defs[VCS_REPOSITORY]);
  const diff = methodsOf(defs[VCS_DIFF]);
  for (const method of [
    ...Object.values(changes),
    ...Object.values(refs),
    ...Object.values(repository),
    ...Object.values(diff),
    ...Object.values(methodsOf(defs[VCS_STATUS])),
  ]) {
    NodeAssert.equal(method.inputSchema.additionalProperties, false, method.name);
  }
  NodeAssert.equal(changes.stage.inputSchema.properties.paths.maxItems, 100);
  NodeAssert.equal(changes.stage.inputSchema.properties.paths.minItems, 1);
  NodeAssert.equal(changes.stage.inputSchema.properties.paths.items.maxLength, 512);
  NodeAssert.equal(changes.commit.inputSchema.properties.message.maxLength, 10000);
  NodeAssert.equal(refs.list.inputSchema.properties.limit.maximum, 200);
  NodeAssert.equal(refs.list.inputSchema.properties.query.maxLength, 256);
  NodeAssert.equal(refs.create.inputSchema.properties.refName.maxLength, 256);
  NodeAssert.ok(refs.create.inputSchema.properties.refName.allOf.length >= 8);
  NodeAssert.equal(diff.getFileContents.inputSchema.properties.oldPath.maxLength, 512);
  NodeAssert.equal(repository.createWorktree.inputSchema.properties.path.maxLength, 32768);
  // Revision inputs must reject `-`-prefixed values — they reach git argv
  // where an option like `--output=` would write outside the workspace.
  for (const property of [
    diff.getPreview.inputSchema.properties.baseRef,
    diff.getFileContents.inputSchema.properties.baseRef,
    diff.getFileContents.inputSchema.properties.headRef,
  ]) {
    const clauses = property.allOf ?? property.anyOf.find((alt) => alt.allOf)?.allOf;
    NodeAssert.ok(
      clauses?.some(
        (clause) => clause.not && new RegExp(clause.not.pattern).test("--output=/tmp/escape"),
      ),
      "revspec schema must reject option injection",
    );
    NodeAssert.ok(
      !clauses?.some((clause) => clause.not && new RegExp(clause.not.pattern).test("HEAD~2")),
      "revspec schema must still accept ordinary revspecs",
    );
  }
});

NodeTest.test("diff outputs preserve bounded payloads and truthful truncation", () => {
  const diff = methodsOf(defs[VCS_DIFF]);
  const source = diff.getPreview.outputSchema.properties.sources.items;
  NodeAssert.equal(source.properties.diff.maxLength, 512000);
  NodeAssert.equal(source.required.includes("truncated"), true);
  NodeAssert.equal(diff.getPreview.outputSchema.properties.sources.maxItems, 8);
  NodeAssert.equal(diff.getFileContents.outputSchema.properties.oldContents.maxLength, 1048576);
  NodeAssert.equal(diff.getFileContents.outputSchema.properties.newContents.maxLength, 1048576);
});

NodeTest.test("getCapabilities reports driver kind, flags, and per-operation support", () => {
  const output = methodsOf(defs[VCS_REPOSITORY]).getCapabilities.outputSchema;
  NodeAssert.deepEqual([...output.required].sort(), [
    "detail",
    "detected",
    "driver",
    "kind",
    "operations",
  ]);
  const driver = output.properties.driver;
  NodeAssert.ok(driver.required.includes("supportsWorktrees"));
  NodeAssert.deepEqual(driver.properties.kind.enum, ["git", "jj", "unknown"]);
  const operations = output.properties.operations;
  for (const key of [
    "changes.stage",
    "changes.commit",
    "refs.switch",
    "repository.pull",
    "repository.createWorktree",
    "repository.push",
    "repository.fetch",
    "repository.listRemotes",
    "diff.getFileContents",
  ]) {
    NodeAssert.equal(operations.properties[key].type, "boolean", key);
  }
  // The frozen 1.0.0 operations map carries none of the 1.1.0 keys.
  const operationsV1 =
    methodsOf(VCS_REPOSITORY_API_V1).getCapabilities.outputSchema.properties.operations;
  for (const key of ["repository.push", "repository.fetch", "repository.listRemotes"]) {
    NodeAssert.equal(operationsV1.properties[key], undefined, `frozen 1.0.0 must lack ${key}`);
  }
});
