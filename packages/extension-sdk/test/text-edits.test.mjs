import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { copyJson } from "../dist/contracts.js";
import {
  EDITABLE_TEXT_MAX_BYTES,
  GENERIC_API_CATALOGUE,
  REVISION_HEX_LENGTH,
  WORKSPACE_READ_TEXT_EDITS,
  WORKSPACE_READ_TEXT_GRANT,
  WORKSPACE_WRITE_TEXT,
  isTextRevision,
  textEditsApi,
  textEditsApiV1,
  validateReadSnapshotInput,
  validateReadSnapshotResult,
  validateSaveInput,
  validateSaveResult,
} from "../dist/catalogue.js";

const utf8 = (value) => new TextEncoder().encode(value).length;

/** Contract validators throw on invalid input; these helpers pin that. */
const rejects = (fn, value) => {
  NodeAssert.throws(() => fn(value), Error);
};

NodeTest.test("text-edits contract identity and frozen constants", () => {
  NodeAssert.equal(textEditsApi.definition.id, WORKSPACE_READ_TEXT_EDITS);
  NodeAssert.equal(textEditsApi.definition.version, "1.1.0");
  NodeAssert.equal(textEditsApiV1.definition.id, WORKSPACE_READ_TEXT_EDITS);
  NodeAssert.equal(textEditsApiV1.definition.version, "1.0.0");
  NodeAssert.equal(WORKSPACE_READ_TEXT_EDITS, "t3.workspace/text-edits");
  NodeAssert.equal(WORKSPACE_READ_TEXT_GRANT, "t3.workspace/read-text");
  NodeAssert.equal(WORKSPACE_WRITE_TEXT, "t3.workspace/write-text");
  NodeAssert.equal(EDITABLE_TEXT_MAX_BYTES, 24000);
  NodeAssert.equal(REVISION_HEX_LENGTH, 64);
  const byName = Object.fromEntries(
    textEditsApi.definition.methods.map((method) => [method.name, method]),
  );
  NodeAssert.deepEqual(byName.readSnapshot.requiredGrants, [WORKSPACE_READ_TEXT_GRANT]);
  NodeAssert.deepEqual(byName.save.requiredGrants, [WORKSPACE_WRITE_TEXT]);
  NodeAssert.equal(byName.save.effect, "write");
  NodeAssert.equal(byName.readSnapshot.effect, "read");
  NodeAssert.deepEqual(Object.keys(byName).sort(), ["readSnapshot", "save"]);
});

NodeTest.test("catalogue registers every frozen textEditsApi version once", () => {
  const registered = GENERIC_API_CATALOGUE.filter(
    (entry) => entry.id === "t3.workspace/text-edits",
  );
  NodeAssert.deepEqual(
    registered.map((entry) => entry.version),
    ["1.1.0", "1.0.0"],
  );
  NodeAssert.equal(registered[0], textEditsApi.definition);
  NodeAssert.equal(registered[1], textEditsApiV1.definition);
});

NodeTest.test("advertised contents bounds match the enforced byte bound", () => {
  // JSON Schema maxLength counts UTF-16 units; it may never exceed the real
  // byte bound or it would advertise content every layer rejects. The 1.0.0
  // definition is frozen and keeps its historical (never honored) bound.
  const byName = Object.fromEntries(
    textEditsApi.definition.methods.map((method) => [method.name, method]),
  );
  const saveContents = byName.save.inputSchema.properties.contents;
  const editableBranch = byName.readSnapshot.outputSchema.oneOf.find(
    (branch) => branch.properties?.kind?.const === "editable",
  );
  NodeAssert.equal(saveContents.maxLength, EDITABLE_TEXT_MAX_BYTES);
  NodeAssert.equal(editableBranch.properties.contents.maxLength, EDITABLE_TEXT_MAX_BYTES);
  NodeAssert.match(saveContents.description, /UTF-8 bytes/);
  NodeAssert.match(editableBranch.properties.contents.description, /UTF-8 bytes/);
});

NodeTest.test("save input bound is enforced in UTF-8 bytes for every content class", () => {
  const base = { relativePath: "doc.txt", expectedRevision: "a".repeat(64) };
  const atBound = (unit, unitBytes) => {
    const count = Math.floor(EDITABLE_TEXT_MAX_BYTES / unitBytes);
    const pad = EDITABLE_TEXT_MAX_BYTES - count * unitBytes;
    return { contents: unit.repeat(count) + "a".repeat(pad), over: unit.repeat(count + 1) };
  };
  for (const [label, unit, unitBytes] of [
    ["ascii", "a", 1],
    ["two-byte", "é", 2],
    ["three-byte", "界", 3],
    ["astral", "\u{1F600}", 4],
    ["escape-heavy", '\n\t"\\\r', 5],
  ]) {
    const { contents, over } = atBound(unit, unitBytes);
    NodeAssert.equal(utf8(contents), EDITABLE_TEXT_MAX_BYTES, label);
    NodeAssert.equal(validateSaveInput({ ...base, contents }).contents, contents, label);
    NodeAssert.throws(
      () => validateSaveInput({ ...base, contents: over }),
      /byte editable bound/,
      label,
    );
    // The advertised schema bound (UTF-16 units) must never reject accepted input.
    NodeAssert.ok(contents.length <= EDITABLE_TEXT_MAX_BYTES, label);
  }
  // A 30000-character ASCII save fails with the named bound, never a generic
  // validation or IO error.
  NodeAssert.throws(
    () => validateSaveInput({ ...base, contents: "x".repeat(30000) }),
    /24000-byte editable bound/,
  );
  // Astral text passes the old character check yet exceeds bytes.
  const astral = "\u{1F600}".repeat(12000); // 24000 UTF-16 units, 48000 bytes
  NodeAssert.equal(astral.length, EDITABLE_TEXT_MAX_BYTES);
  NodeAssert.throws(
    () => validateSaveInput({ ...base, contents: astral }),
    /24000-byte editable bound/,
  );
});

NodeTest.test("read snapshot results enforce the same byte bound", () => {
  const base = { kind: "editable", relativePath: "doc.txt", revision: "b".repeat(64) };
  const ok = { ...base, contents: "é".repeat(12000) }; // 24000 bytes
  NodeAssert.deepEqual(validateReadSnapshotResult(ok), ok);
  NodeAssert.throws(
    () => validateReadSnapshotResult({ ...base, contents: "é".repeat(12001) }),
    /24000-byte editable bound/,
  );
});

NodeTest.test("envelope overflow names the offending field", () => {
  const payload = {
    relativePath: "doc.txt",
    expectedRevision: "a".repeat(64),
    contents: "x".repeat(70000),
  };
  NodeAssert.throws(() => copyJson(payload), /byte limit.*"contents"/);
  NodeAssert.throws(() => copyJson(payload), /65536-byte envelope/);
});

NodeTest.test("save input accepts the frozen shape and rejects everything else", () => {
  const valid = {
    relativePath: "docs/notes.md",
    expectedRevision: "a".repeat(64),
    contents: "hello",
  };
  NodeAssert.deepEqual(validateSaveInput(valid), valid);
  rejects(validateSaveInput, { ...valid, force: true });
  rejects(validateSaveInput, { ...valid, encoding: "base64" });
  rejects(validateSaveInput, { ...valid, expectedRevision: "short" });
  rejects(validateSaveInput, { ...valid, relativePath: "../escape.txt" });
  rejects(validateSaveInput, { ...valid, relativePath: "/abs/path" });
  rejects(validateSaveInput, { ...valid, relativePath: "a\\b.txt" });
  rejects(validateSaveInput, { ...valid, relativePath: "a/./b" });
  rejects(validateSaveInput, { ...valid, relativePath: "." });
  rejects(validateSaveInput, { ...valid, contents: 42 });
  rejects(validateSaveInput, { relativePath: "x", expectedRevision: "a".repeat(64) });
  rejects(validateSaveInput, null);
});

NodeTest.test("readSnapshot input rejects extra fields and invalid paths", () => {
  NodeAssert.deepEqual(validateReadSnapshotInput({ relativePath: "ok.txt" }), {
    relativePath: "ok.txt",
  });
  rejects(validateReadSnapshotInput, { relativePath: "ok.txt", cwd: "/tmp" });
  rejects(validateReadSnapshotInput, { relativePath: "" });
  rejects(validateReadSnapshotInput, { relativePath: "../up" });
  rejects(validateReadSnapshotInput, {});
  rejects(validateReadSnapshotInput, { relativePath: "x".repeat(513) });
});

NodeTest.test("revision validator gates lowercase hex shape", () => {
  NodeAssert.equal(isTextRevision("0".repeat(64)), true);
  NodeAssert.equal(isTextRevision("g".repeat(64)), false);
  NodeAssert.equal(isTextRevision("a".repeat(63)), false);
  NodeAssert.equal(isTextRevision("A".repeat(64)), false);
});

const editable = {
  kind: "editable",
  relativePath: "doc.txt",
  contents: "hello",
  revision: "b".repeat(64),
};
const notEditable = { kind: "not-editable", relativePath: "doc.txt", reason: "binary" };
const saved = { kind: "saved", relativePath: "doc.txt", revision: "c".repeat(64) };
const conflict = { kind: "conflict", relativePath: "doc.txt" };

NodeTest.test("result validators admit exactly the frozen unions", () => {
  NodeAssert.deepEqual(validateReadSnapshotResult(editable), editable);
  NodeAssert.deepEqual(validateReadSnapshotResult(notEditable), notEditable);
  rejects(validateReadSnapshotResult, { ...editable, extra: 1 });
  rejects(validateReadSnapshotResult, { ...notEditable, reason: "explosion" });
  rejects(validateReadSnapshotResult, saved);
  rejects(validateReadSnapshotResult, { ...editable, revision: "zz" });
  NodeAssert.deepEqual(validateSaveResult(saved), saved);
  NodeAssert.deepEqual(validateSaveResult(conflict), conflict);
  rejects(validateSaveResult, notEditable);
  rejects(validateSaveResult, { ...saved, revision: "zz" });
  rejects(validateSaveResult, { ...conflict, reason: "binary" });
});

NodeTest.test(
  "host read outcomes unsafe-path and changed-during-read validate against the schema",
  () => {
    // The host passes workspace/textEdits reasons straight through; both of
    // these reach the broker's AJV output validation on real reads.
    const unsafe = { kind: "not-editable", relativePath: "link.txt", reason: "unsafe-path" };
    const changed = {
      kind: "not-editable",
      relativePath: "doc.txt",
      reason: "changed-during-read",
    };
    NodeAssert.deepEqual(validateReadSnapshotResult(unsafe), unsafe);
    NodeAssert.deepEqual(validateReadSnapshotResult(changed), changed);
    const schema = textEditsApi.definition.methods.find(
      (m) => m.name === "readSnapshot",
    ).outputSchema;
    const branch = schema.oneOf.find((b) => b.properties?.kind?.const === "not-editable");
    for (const value of [unsafe, changed])
      NodeAssert.equal(
        branch.properties.reason.enum.includes(value.reason),
        true,
        value.reason + " must be in the outputSchema enum",
      );
    // "aborted" is save-side only and must stay out of the read union.
    NodeAssert.equal(branch.properties.reason.enum.includes("aborted"), false);
    rejects(validateReadSnapshotResult, { ...notEditable, reason: "aborted" });
  },
);
