import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { MAX_PAYLOAD_BYTES } from "../dist/contracts.js";
import {
  COMPOSER_CONTEXT,
  COMPOSER_CONTEXT_API,
  COMPOSER_WRITE,
  GENERIC_API_CATALOGUE,
  MESSAGES_ENRICHMENT,
  MESSAGES_ENRICHMENT_API,
  MESSAGES_WRITE,
  assertProvidedApiOwner,
  composerContextApi,
  messagesEnrichmentApi,
} from "../dist/catalogue.js";
import { validateApiDefinition } from "../dist/capabilities.js";
import { CLIENT_COMPOSER_API } from "../dist/clientProviders.js";

const methodsOf = (definition) =>
  Object.fromEntries((definition.methods ?? []).map((m) => [m.name, m]));

NodeTest.test("both contracts are registered at 1.1.0 with stable ids", () => {
  NodeAssert.equal(COMPOSER_CONTEXT_API.id, "t3.composer/context");
  NodeAssert.equal(COMPOSER_CONTEXT_API.id, COMPOSER_CONTEXT);
  NodeAssert.equal(COMPOSER_CONTEXT_API.version, "1.1.0");
  NodeAssert.equal(composerContextApi.definition, COMPOSER_CONTEXT_API);
  NodeAssert.equal(MESSAGES_ENRICHMENT_API.id, "t3.messages/enrichment");
  NodeAssert.equal(MESSAGES_ENRICHMENT_API.id, MESSAGES_ENRICHMENT);
  NodeAssert.equal(MESSAGES_ENRICHMENT_API.version, "1.1.0");
  NodeAssert.equal(messagesEnrichmentApi.definition, MESSAGES_ENRICHMENT_API);
  NodeAssert.ok(GENERIC_API_CATALOGUE.includes(COMPOSER_CONTEXT_API));
  NodeAssert.ok(GENERIC_API_CATALOGUE.includes(MESSAGES_ENRICHMENT_API));
  for (const definition of [COMPOSER_CONTEXT_API, MESSAGES_ENRICHMENT_API]) {
    NodeAssert.deepEqual(validateApiDefinition(definition), definition);
    // The catalogue definitions are canonical — the same api may be provided
    // by the host (or a plugin that re-declares it canonically).
    NodeAssert.doesNotThrow(() => assertProvidedApiOwner("other.plugin", definition));
  }
});

NodeTest.test("grants split write authority across the two contracts", () => {
  const composer = methodsOf(COMPOSER_CONTEXT_API);
  NodeAssert.deepEqual(Object.keys(composer).sort(), [
    "getCapabilities",
    "getDraftState",
    "insertContext",
    "insertMention",
    "insertTerminalContext",
  ]);
  NodeAssert.deepEqual(composer.getCapabilities.requiredGrants, []);
  NodeAssert.equal(composer.getCapabilities.effect, "read");
  NodeAssert.deepEqual(composer.insertContext.requiredGrants, [COMPOSER_WRITE]);
  NodeAssert.equal(composer.insertContext.effect, "write");
  NodeAssert.deepEqual(composer.getDraftState.requiredGrants, [COMPOSER_WRITE]);
  NodeAssert.equal(composer.getDraftState.effect, "read");
  NodeAssert.deepEqual(composer.insertMention.requiredGrants, [COMPOSER_WRITE]);
  NodeAssert.equal(composer.insertMention.effect, "write");
  NodeAssert.deepEqual(composer.insertTerminalContext.requiredGrants, [COMPOSER_WRITE]);
  NodeAssert.equal(composer.insertTerminalContext.effect, "write");

  const enrichment = methodsOf(MESSAGES_ENRICHMENT_API);
  NodeAssert.deepEqual(Object.keys(enrichment).sort(), [
    "attachAnnotation",
    "getCapabilities",
    "listAnnotations",
    "removeAnnotation",
  ]);
  NodeAssert.deepEqual(enrichment.getCapabilities.requiredGrants, []);
  NodeAssert.deepEqual(enrichment.attachAnnotation.requiredGrants, [MESSAGES_WRITE]);
  NodeAssert.equal(enrichment.attachAnnotation.effect, "write");
  NodeAssert.deepEqual(enrichment.listAnnotations.requiredGrants, [MESSAGES_WRITE]);
  NodeAssert.equal(enrichment.listAnnotations.effect, "read");
  NodeAssert.deepEqual(enrichment.removeAnnotation.requiredGrants, [MESSAGES_WRITE]);
  NodeAssert.equal(enrichment.removeAnnotation.effect, "write");
  // No free-form send exists anywhere on either contract.
  for (const definition of [COMPOSER_CONTEXT_API, MESSAGES_ENRICHMENT_API]) {
    for (const method of definition.methods ?? []) {
      NodeAssert.ok(!/send|prompt/i.test(method.name), method.name);
    }
  }
});

NodeTest.test("insertContext input is closed and bounded", () => {
  const input = methodsOf(COMPOSER_CONTEXT_API).insertContext.inputSchema;
  NodeAssert.equal(input.additionalProperties, false);
  NodeAssert.deepEqual(input.required, ["refs"]);
  NodeAssert.equal(input.properties.refs.maxItems, 8);
  NodeAssert.equal(input.properties.refs.minItems, 1);
  const ref = input.properties.refs.items;
  NodeAssert.equal(ref.additionalProperties, false);
  NodeAssert.deepEqual(ref.required, ["path"]);
  NodeAssert.equal(ref.properties.path.maxLength, 512);
  NodeAssert.equal(ref.properties.excerpt.maxLength, 512);
  NodeAssert.equal(input.properties.threadId.maxLength, 128);
});

NodeTest.test("attachAnnotation input is closed and bounded", () => {
  const input = methodsOf(MESSAGES_ENRICHMENT_API).attachAnnotation.inputSchema;
  NodeAssert.equal(input.additionalProperties, false);
  NodeAssert.deepEqual(input.required, ["annotation"]);
  const variants = input.properties.annotation.oneOf;
  NodeAssert.equal(variants.length, 2);
  const [file, diff] = variants;
  NodeAssert.equal(file.additionalProperties, false);
  NodeAssert.deepEqual(file.required, ["filePath", "startLine", "endLine", "body"]);
  NodeAssert.equal(file.properties.filePath.maxLength, 512);
  NodeAssert.equal(file.properties.body.maxLength, 4096);
  NodeAssert.equal(file.properties.excerpt.maxLength, 4096);
  // The 1.0.0 file variant is unchanged — no kind field, same bounds.
  NodeAssert.equal(file.properties.kind, undefined);
  NodeAssert.equal(diff.additionalProperties, false);
  NodeAssert.deepEqual(diff.required, [
    "kind",
    "filePath",
    "sectionId",
    "sectionTitle",
    "rangeLabel",
    "diff",
    "selection",
    "body",
  ]);
  NodeAssert.deepEqual(diff.properties.kind, { const: "diff" });
  NodeAssert.equal(diff.properties.sectionId.maxLength, 512);
  NodeAssert.equal(diff.properties.sectionTitle.maxLength, 256);
  NodeAssert.equal(diff.properties.rangeLabel.maxLength, 128);
  NodeAssert.equal(diff.properties.diff.maxLength, 4096);
  NodeAssert.equal(diff.properties.body.maxLength, 4096);
  NodeAssert.equal(diff.properties.startIndex.minimum, 0);
  NodeAssert.equal(diff.properties.endIndex.maximum, 1_000_000);
  const selection = diff.properties.selection;
  NodeAssert.equal(selection.additionalProperties, false);
  NodeAssert.deepEqual(selection.required, ["start", "side", "end", "endSide"]);
  NodeAssert.deepEqual(selection.properties.side.enum, ["additions", "deletions"]);
  NodeAssert.deepEqual(selection.properties.endSide.enum, ["additions", "deletions"]);
});

NodeTest.test("insertMention and insertTerminalContext inputs are closed and bounded", () => {
  const composer = methodsOf(COMPOSER_CONTEXT_API);
  const mention = composer.insertMention.inputSchema;
  NodeAssert.equal(mention.additionalProperties, false);
  NodeAssert.deepEqual(mention.required, ["paths"]);
  NodeAssert.equal(mention.properties.paths.minItems, 1);
  NodeAssert.equal(mention.properties.paths.maxItems, 8);
  NodeAssert.equal(mention.properties.paths.items.maxLength, 512);
  const terminal = composer.insertTerminalContext.inputSchema;
  NodeAssert.equal(terminal.additionalProperties, false);
  NodeAssert.deepEqual(terminal.required, [
    "terminalId",
    "terminalLabel",
    "lineStart",
    "lineEnd",
    "text",
  ]);
  NodeAssert.equal(terminal.properties.terminalId.maxLength, 128);
  NodeAssert.equal(terminal.properties.terminalLabel.maxLength, 128);
  NodeAssert.equal(terminal.properties.text.maxLength, 10000);
  NodeAssert.equal(terminal.properties.lineStart.minimum, 1);
  const removal = methodsOf(MESSAGES_ENRICHMENT_API).removeAnnotation.inputSchema;
  NodeAssert.equal(removal.additionalProperties, false);
  NodeAssert.deepEqual(removal.required, ["annotationId"]);
  NodeAssert.equal(removal.properties.annotationId.maxLength, 256);
  const listing = methodsOf(MESSAGES_ENRICHMENT_API).listAnnotations.inputSchema;
  NodeAssert.equal(listing.additionalProperties, false);
  NodeAssert.equal(listing.properties.annotationId, undefined);
});

NodeTest.test("the private client-provider seam carries every 1.1.0 op", () => {
  // The broker's METHOD_SCHEMAS table is built from this definition — an op
  // missing here can never cross to the client, whatever the public contract
  // or web provider support.
  NodeAssert.equal(CLIENT_COMPOSER_API.id, "t3.client/composer");
  NodeAssert.equal(CLIENT_COMPOSER_API.version, "1.1.0");
  NodeAssert.deepEqual(methodsOf(CLIENT_COMPOSER_API).insertMention.inputSchema.required, [
    "target",
    "threadId",
    "paths",
  ]);
  const seam = methodsOf(CLIENT_COMPOSER_API);
  for (const name of [
    "insertContext",
    "getDraftState",
    "attachAnnotation",
    "insertMention",
    "insertTerminalContext",
    "listAnnotations",
    "removeAnnotation",
  ]) {
    NodeAssert.ok(seam[name], name);
    // Every frame carries the adapter-set target; plugin envelopes never do.
    NodeAssert.ok(seam[name].inputSchema.required.includes("target"), name);
  }
  const seamAnnotation = seam.attachAnnotation.inputSchema.properties.annotation;
  NodeAssert.equal(seamAnnotation.oneOf.length, 2);
  NodeAssert.equal(seamAnnotation.oneOf[0].properties.kind, undefined);
  NodeAssert.deepEqual(seamAnnotation.oneOf[1].properties.kind, { const: "diff" });
  NodeAssert.deepEqual(seamAnnotation.oneOf[1].properties.selection.properties.side.enum, [
    "additions",
    "deletions",
  ]);
  NodeAssert.equal(seam.insertMention.inputSchema.properties.paths.maxItems, 8);
  NodeAssert.equal(seam.insertTerminalContext.inputSchema.properties.text.maxLength, 10000);
  NodeAssert.equal(seam.listAnnotations.outputSchema.properties.annotations.maxItems, 8);
  NodeAssert.deepEqual(
    seam.listAnnotations.outputSchema.properties.annotations.items.properties.kind.enum,
    ["file", "diff"],
  );
  NodeAssert.equal(seam.removeAnnotation.inputSchema.properties.annotationId.maxLength, 256);
});

NodeTest.test("capability honesty output names per-op support and transport", () => {
  for (const [definition, ops] of [
    [
      COMPOSER_CONTEXT_API,
      ["insertContext", "getDraftState", "insertMention", "insertTerminalContext"],
    ],
    [MESSAGES_ENRICHMENT_API, ["attachAnnotation", "listAnnotations", "removeAnnotation"]],
  ]) {
    const output = methodsOf(definition).getCapabilities.outputSchema;
    NodeAssert.equal(output.additionalProperties, false);
    NodeAssert.deepEqual(output.required, ["adapter", "transport", "detail", "operations"]);
    NodeAssert.deepEqual(output.properties.transport.enum, ["server", "client", "unavailable"]);
    NodeAssert.deepEqual(output.properties.operations.required, ops);
    NodeAssert.equal(output.properties.operations.additionalProperties, false);
  }
});

const utf8Bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
// Worst-case JSON expansion is 6 bytes per char (C0 controls → \uXXXX escapes).
const worst = (length) => "\u0000".repeat(length);

NodeTest.test("schema-maximum inputs always fit the 64 KiB invoke envelope", () => {
  // insertContext: threadId + 8 refs at path/excerpt/line maxima.
  const insert = {
    threadId: worst(128),
    refs: Array.from({ length: 8 }, () => ({
      path: worst(512),
      startLine: 1000000,
      endLine: 1000000,
      excerpt: worst(512),
    })),
  };
  NodeAssert.ok(
    utf8Bytes(insert) < MAX_PAYLOAD_BYTES,
    `insertContext worst case ${utf8Bytes(insert)} >= ${MAX_PAYLOAD_BYTES}`,
  );
  // attachAnnotation: threadId + filePath + body + excerpt at maxima.
  const annotation = {
    threadId: worst(128),
    annotation: {
      filePath: worst(512),
      startLine: 1000000,
      endLine: 1000000,
      body: worst(4096),
      excerpt: worst(4096),
    },
  };
  NodeAssert.ok(
    utf8Bytes(annotation) < MAX_PAYLOAD_BYTES,
    `attachAnnotation worst case ${utf8Bytes(annotation)} >= ${MAX_PAYLOAD_BYTES}`,
  );
  // attachAnnotation diff variant: every string field at its maximum.
  const diffAnnotation = {
    threadId: worst(128),
    annotation: {
      kind: "diff",
      filePath: worst(512),
      sectionId: worst(512),
      sectionTitle: worst(256),
      rangeLabel: worst(128),
      diff: worst(4096),
      body: worst(4096),
      startIndex: 1000000,
      endIndex: 1000000,
      selection: { start: 1000000, side: "additions", end: 1000000, endSide: "deletions" },
    },
  };
  NodeAssert.ok(
    utf8Bytes(diffAnnotation) < MAX_PAYLOAD_BYTES,
    `diff attachAnnotation worst case ${utf8Bytes(diffAnnotation)} >= ${MAX_PAYLOAD_BYTES}`,
  );
  // insertTerminalContext: ids at 128 + text at 10,000 chars.
  const terminal = {
    threadId: worst(128),
    terminalId: worst(128),
    terminalLabel: worst(128),
    lineStart: 1000000,
    lineEnd: 1000000,
    text: worst(10000),
  };
  NodeAssert.ok(
    utf8Bytes(terminal) < MAX_PAYLOAD_BYTES,
    `insertTerminalContext worst case ${utf8Bytes(terminal)} >= ${MAX_PAYLOAD_BYTES}`,
  );
  // insertMention: 8 paths at 512 chars.
  const mention = {
    threadId: worst(128),
    paths: Array.from({ length: 8 }, () => worst(512)),
  };
  NodeAssert.ok(
    utf8Bytes(mention) < MAX_PAYLOAD_BYTES,
    `insertMention worst case ${utf8Bytes(mention)} >= ${MAX_PAYLOAD_BYTES}`,
  );
  // listAnnotations output: 8 entries at their field maxima (8 × 6,912 B ≈
  // 54 KB worst-case, inside the 64 KiB frame envelope).
  const listed = {
    annotations: Array.from({ length: 8 }, () => ({
      annotationId: worst(256),
      kind: "diff",
      filePath: worst(512),
      rangeLabel: worst(128),
      sectionTitle: worst(256),
    })),
  };
  NodeAssert.ok(
    utf8Bytes(listed) < MAX_PAYLOAD_BYTES,
    `listAnnotations worst case ${utf8Bytes(listed)} >= ${MAX_PAYLOAD_BYTES}`,
  );
  // getDraftState output: prompt at maxLength + counts + flag.
  const draft = {
    draft: {
      prompt: worst(10000),
      promptTruncated: true,
      contextCounts: {
        files: 10000,
        images: 10000,
        terminalContexts: 10000,
        elementContexts: 10000,
        previewAnnotations: 10000,
        reviewComments: 10000,
      },
    },
  };
  NodeAssert.ok(
    utf8Bytes(draft) < MAX_PAYLOAD_BYTES,
    `getDraftState worst case ${utf8Bytes(draft)} >= ${MAX_PAYLOAD_BYTES}`,
  );
});

NodeTest.test("unicode and escaped boundaries stay inside the envelope", () => {
  // 4-byte emoji are the widest unescaped content; C0 controls the widest escaped.
  const emoji = "😀".repeat(5000); // 5,000 non-BMP chars = 10,000 UTF-16 units (the maxLength domain)
  const draft = {
    draft: {
      prompt: emoji,
      promptTruncated: false,
      contextCounts: {
        files: 0,
        images: 0,
        terminalContexts: 0,
        elementContexts: 0,
        previewAnnotations: 0,
        reviewComments: 0,
      },
    },
  };
  NodeAssert.ok(utf8Bytes(draft) < MAX_PAYLOAD_BYTES);
  const escapable = '"\\\n'.repeat(1024); // 4,096 chars of quote/backslash/newline
  const annotation = {
    annotation: {
      filePath: "a.ts",
      startLine: 1,
      endLine: 2,
      body: escapable,
      excerpt: escapable,
    },
  };
  NodeAssert.ok(utf8Bytes(annotation) < MAX_PAYLOAD_BYTES);
});
