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
  uiPanelsApi,
  messagesEnrichmentApi,
} from "../dist/catalogue.js";
import { validateApiDefinition } from "../dist/capabilities.js";
import { CLIENT_COMPOSER_API, CLIENT_COMPOSER_V12_RANGE } from "../dist/clientProviders.js";
import * as ClientProviders from "../dist/clientProviders.js";
import * as Catalogue from "../dist/catalogue.js";
import { ApiVersionError, bindApi } from "../dist/capabilities.js";

/** listAnnotations' 1.2.0 text preview bound, pinned by the envelope test. */
const LISTED_TEXT_MAX = 160;

const methodsOf = (definition) =>
  Object.fromEntries((definition.methods ?? []).map((m) => [m.name, m]));

NodeTest.test("annotation and mini-player additions require explicit version opt-in", async () => {
  const context = {
    client: "desktop",
    resource: {
      namespace: "test",
      id: "view",
      environmentId: "env",
      projectId: "project",
      threadId: "thread",
    },
  };
  const client = {
    invokeApi: async () => ({
      inserted: true,
      imageInserted: false,
      screenshotFailed: false,
      target: "env:thread",
    }),
  };
  const signal = new AbortController().signal;
  await NodeAssert.rejects(
    bindApi(composerContextApi, client, context).invoke(
      "insertPreviewAnnotation",
      { annotationRef: "pick-ref" },
      signal,
    ),
    ApiVersionError,
  );
  await NodeAssert.rejects(
    bindApi(uiPanelsApi, client, context).invoke(
      "setBrowserMiniPlayer",
      { tabId: "tab", serverEpoch: "epoch", open: true },
      signal,
    ),
    ApiVersionError,
  );
  NodeAssert.equal(
    (
      await bindApi(composerContextApi, client, context, "^1.3.0").invoke(
        "insertPreviewAnnotation",
        { annotationRef: "pick-ref" },
        signal,
      )
    ).inserted,
    true,
  );
  const insert = methodsOf(COMPOSER_CONTEXT_API).insertPreviewAnnotation;
  NodeAssert.deepEqual(insert.requiredGrants, [COMPOSER_WRITE]);
  NodeAssert.deepEqual(Object.keys(insert.inputSchema.properties), ["threadId", "annotationRef"]);
  NodeAssert.equal(insert.inputSchema.properties.annotationRef.maxLength, 128);
  NodeAssert.deepEqual(methodsOf(uiPanelsApi.definition).setBrowserMiniPlayer.requiredGrants, [
    "t3.ui/panels",
    "t3.browser/sessions",
  ]);
});

NodeTest.test("both contracts are registered with stable ids", () => {
  NodeAssert.equal(COMPOSER_CONTEXT_API.id, "t3.composer/context");
  NodeAssert.equal(COMPOSER_CONTEXT_API.id, COMPOSER_CONTEXT);
  NodeAssert.equal(COMPOSER_CONTEXT_API.version, "1.3.0");
  NodeAssert.equal(composerContextApi.definition, COMPOSER_CONTEXT_API);
  NodeAssert.equal(MESSAGES_ENRICHMENT_API.id, "t3.messages/enrichment");
  NodeAssert.equal(MESSAGES_ENRICHMENT_API.id, MESSAGES_ENRICHMENT);
  NodeAssert.equal(MESSAGES_ENRICHMENT_API.version, "1.2.0");
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
    "insertImage",
    "insertMention",
    "insertPreviewAnnotation",
    "insertTerminalContext",
  ]);
  NodeAssert.deepEqual(composer.insertImage.requiredGrants, [COMPOSER_WRITE]);
  NodeAssert.equal(composer.insertImage.effect, "write");
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
    "getAnnotation",
    "getCapabilities",
    "listAnnotations",
    "removeAnnotation",
  ]);
  NodeAssert.deepEqual(enrichment.getAnnotation.requiredGrants, [MESSAGES_WRITE]);
  NodeAssert.equal(enrichment.getAnnotation.effect, "read");
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

NodeTest.test("insertImage takes only an artifactRef, never image bytes", () => {
  const input = methodsOf(COMPOSER_CONTEXT_API).insertImage.inputSchema;
  NodeAssert.equal(input.additionalProperties, false);
  NodeAssert.deepEqual(input.required, ["artifactRef"]);
  NodeAssert.deepEqual(Object.keys(input.properties).sort(), ["artifactRef", "name", "threadId"]);
  const pattern = new RegExp(input.properties.artifactRef.pattern);
  NodeAssert.ok(pattern.test("pending-0f1e2d3c-4b5a-4968-8776-655443322110"));
  // Settled thread attachments, paths, and data URLs are not capture refs.
  NodeAssert.ok(!pattern.test("thread_1-0f1e2d3c-4b5a-4968-8776-655443322110"));
  NodeAssert.ok(!pattern.test("../pending-0f1e2d3c-4b5a-4968-8776-655443322110"));
  NodeAssert.ok(!pattern.test("data:image/png;base64,AAAA"));
  const seam = methodsOf(CLIENT_COMPOSER_API).insertImage.inputSchema;
  NodeAssert.deepEqual(seam.required, ["target", "threadId", "artifactRef"]);
  NodeAssert.equal(seam.properties.artifactRef.pattern, input.properties.artifactRef.pattern);
  NodeAssert.equal(CLIENT_COMPOSER_V12_RANGE, "^1.2.0");
});

NodeTest.test("the private client-provider seam carries every public op", () => {
  // The broker's METHOD_SCHEMAS table is built from this definition — an op
  // missing here can never cross to the client, whatever the public contract
  // or web provider support.
  NodeAssert.equal(CLIENT_COMPOSER_API.id, "t3.client/composer");
  NodeAssert.equal(CLIENT_COMPOSER_API.version, "1.4.0");
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
    "insertImage",
    "listAnnotations",
    "removeAnnotation",
    "getAnnotation",
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
      [
        "insertContext",
        "getDraftState",
        "insertMention",
        "insertTerminalContext",
        "insertImage",
        "insertPreviewAnnotation",
      ],
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
  // listAnnotations output: 8 entries at their field maxima, the 1.2.0 text
  // preview included (≈ 64 KB worst-case, inside the 64 KiB frame envelope).
  const listed = {
    annotations: Array.from({ length: 8 }, () => ({
      annotationId: worst(256),
      kind: "diff",
      filePath: worst(512),
      rangeLabel: worst(128),
      sectionTitle: worst(256),
      text: worst(LISTED_TEXT_MAX),
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

// Native parity (the composer's review-comment chip shows the comment's
// words): after a reload a pack can list what its own comments say. `text`
// is a 1.2.0 output addition the caller asks for with `include`, bounded so
// eight entries still fit the frame envelope.
NodeTest.test("listAnnotations text is a 1.2.0 addition over a frozen 1.1.0", async () => {
  NodeAssert.equal(messagesEnrichmentApi.baseline, "1.1.0");
  NodeAssert.deepEqual(
    messagesEnrichmentApi.additions.map(({ version, method, input }) => [version, method, input]),
    [
      ["1.2.0", "listAnnotations", "include"],
      ["1.2.0", "getAnnotation", undefined],
    ],
  );
  for (const definition of [MESSAGES_ENRICHMENT_API, CLIENT_COMPOSER_API]) {
    const list = methodsOf(definition).listAnnotations;
    NodeAssert.deepEqual(list.inputSchema.properties.include.items.enum, ["text"]);
    NodeAssert.deepEqual(list.outputSchema.properties.annotations.items.properties.text, {
      type: "string",
      maxLength: LISTED_TEXT_MAX,
    });
    NodeAssert.ok(!list.outputSchema.properties.annotations.items.required.includes("text"));
  }
  NodeAssert.equal(ClientProviders.CLIENT_COMPOSER_V13_RANGE, "^1.3.0");
  const frozen = Catalogue.messagesEnrichmentApiV1_1.definition;
  NodeAssert.equal(frozen.version, "1.1.0");
  NodeAssert.ok(GENERIC_API_CATALOGUE.includes(frozen));
  const frozenList = methodsOf(frozen).listAnnotations;
  NodeAssert.deepEqual(Object.keys(frozenList.inputSchema.properties), ["threadId"]);
  NodeAssert.equal(frozenList.outputSchema.properties.annotations.items.properties.text, undefined);
  // An unprobed binding cannot ask for text.
  const context = { client: "web", resource: { namespace: "ext", id: "ext.a" } };
  await NodeAssert.rejects(
    bindApi(
      messagesEnrichmentApi,
      { invokeApi: async () => ({ annotations: [] }) },
      context,
    ).invoke("listAnnotations", { threadId: "t", include: ["text"] }, new AbortController().signal),
    (error) => error instanceof ApiVersionError,
  );
});

NodeTest.test(
  "listOwnAnnotations asks a 1.2.0 host for text and an older one without",
  async () => {
    NodeAssert.equal(typeof Catalogue.listOwnAnnotations, "function");
    const context = { client: "web", resource: { namespace: "ext", id: "ext.a" } };
    const signal = new AbortController().signal;
    const host = (version) => {
      const requests = [];
      return {
        requests,
        discoverApis: async () => [{ id: "t3.messages/enrichment", version }],
        invokeApi: async (request) => {
          requests.push({ versionRange: request.versionRange, input: request.input });
          return { annotations: [] };
        },
      };
    };
    for (const [version, expected] of [
      ["1.2.0", { versionRange: "^1.2.0", input: { threadId: "t", include: ["text"] } }],
      ["1.1.0", { versionRange: "^1.1.0", input: { threadId: "t" } }],
    ]) {
      const client = host(version);
      NodeAssert.deepEqual(
        await Catalogue.listOwnAnnotations(client, context, { threadId: "t" }, signal),
        { annotations: [] },
      );
      NodeAssert.deepEqual(client.requests, [expected]);
    }
  },
);

// A listed preview says when it was cut, and
// one own comment's whole text is read on its own at 1.2.0.
NodeTest.test("readOwnAnnotationText reads one comment's whole text on a 1.2.0 host", async () => {
  const definition = messagesEnrichmentApi.definition;
  const method = definition.methods.find((m) => m.name === "getAnnotation");
  NodeAssert.ok(method, "getAnnotation is declared");
  NodeAssert.deepEqual(method.requiredGrants, ["t3.messages/write"]);
  NodeAssert.equal(method.outputSchema.oneOf[0].properties.text.maxLength, 4096);
  const listing = definition.methods.find((m) => m.name === "listAnnotations");
  NodeAssert.deepEqual(listing.outputSchema.properties.annotations.items.properties.textTruncated, {
    type: "boolean",
  });
  NodeAssert.ok(
    !Catalogue.messagesEnrichmentApiV1_1.definition.methods.some((m) => m.name === "getAnnotation"),
  );
  const context = { client: "web", resource: { namespace: "ext", id: "ext.a", threadId: "t" } };
  const signal = new AbortController().signal;
  const answers = [];
  for (const [version, reply] of [
    ["1.2.0", { found: true, text: "whole" }],
    ["1.2.0", { found: false }],
    ["1.1.0", { found: true, text: "never asked" }],
  ]) {
    const requests = [];
    const client = {
      discoverApis: async () => [{ id: "t3.messages/enrichment", version }],
      invokeApi: async (request) => {
        requests.push([request.method, request.versionRange, request.input]);
        return reply;
      },
    };
    answers.push([
      await Catalogue.readOwnAnnotationText?.(
        client,
        context,
        { threadId: "t", annotationId: "annotation:ext.a:1" },
        signal,
      ),
      requests,
    ]);
  }
  const asked = [
    ["getAnnotation", "^1.2.0", { threadId: "t", annotationId: "annotation:ext.a:1" }],
  ];
  NodeAssert.deepEqual(answers, [
    ["whole", asked],
    [null, asked],
    [null, []],
  ]);
});

// getAnnotation is a 1.2.0 addition, so a
// binding at the ^1.1.0 baseline refuses it before transport.
NodeTest.test("getAnnotation is refused below ^1.2.0 and dispatched at it", async () => {
  const context = { client: "web", resource: { namespace: "ext", id: "ext.a" } };
  const signal = new AbortController().signal;
  const input = { threadId: "t", annotationId: "annotation:ext.a:1" };
  for (const range of [undefined, "^1.1.0"]) {
    const dispatched = [];
    const client = {
      invokeApi: async (request) => {
        dispatched.push(request.versionRange);
        return { found: false };
      },
    };
    await NodeAssert.rejects(
      bindApi(messagesEnrichmentApi, client, context, range).invoke("getAnnotation", input, signal),
      (error) => error instanceof ApiVersionError && error.code === "api-version-not-negotiated",
    );
    NodeAssert.deepEqual(dispatched, []);
  }
  const dispatched = [];
  const client = {
    invokeApi: async (request) => {
      dispatched.push([request.method, request.versionRange]);
      return { found: false };
    },
  };
  NodeAssert.deepEqual(
    await bindApi(messagesEnrichmentApi, client, context, "^1.2.0").invoke(
      "getAnnotation",
      input,
      signal,
    ),
    { found: false },
  );
  NodeAssert.deepEqual(dispatched, [["getAnnotation", "^1.2.0"]]);
});
