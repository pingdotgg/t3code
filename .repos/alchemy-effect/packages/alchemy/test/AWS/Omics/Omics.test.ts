import * as AWS from "@/AWS";
import {
  AnnotationStore,
  ReferenceStore,
  RunGroup,
  SequenceStore,
  VariantStore,
  Workflow,
} from "@/AWS/Omics";
import * as Test from "@/Test/Alchemy";
import * as omics from "@distilled.cloud/aws/omics";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag every Omics read/delete path depends on. Runs in every CI
// pass at near-zero cost, unlike the gated lifecycles below.
test.provider(
  "getReferenceStore on a nonexistent id fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        omics.getReferenceStore({ id: "1234567890" }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

// Ungated probes for the `analytics-` HealthOmics endpoint (annotation/variant
// stores). A missing-store read is safe (creates nothing) and proves both the
// operation-level `analytics-` hostPrefix routing and the typed not-found tag
// the AnnotationStore/VariantStore providers depend on. The create path for
// these two stores is entitlement-gated (see the gated lifecycles below).
test.provider(
  "getAnnotationStore on a nonexistent name fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        omics.getAnnotationStore({ name: "alchemy_probe_nonexistent_store" }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

test.provider(
  "getVariantStore on a nonexistent name fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        omics.getVariantStore({ name: "alchemy_probe_nonexistent_store" }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

const assertReferenceStoreGone = (id: string) =>
  Effect.gen(function* () {
    const gone = yield* omics.getReferenceStore({ id }).pipe(
      Effect.map(() => false),
      Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(true)),
    );
    if (!gone) {
      return yield* Effect.fail(
        new Error(`reference store '${id}' still exists`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("3 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "ReferenceStore: create, verify out-of-band, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { store } = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* ReferenceStore("Refs", {
            description: "alchemy omics test reference store",
            tags: { fixture: "omics-reference-store" },
          });
          return { store };
        }),
      );

      expect(store.referenceStoreId).toBeDefined();
      expect(store.referenceStoreArn).toContain(":referenceStore/");

      const live = yield* omics.getReferenceStore({
        id: store.referenceStoreId,
      });
      expect(live.id).toBe(store.referenceStoreId);
      expect(live.description).toBe("alchemy omics test reference store");

      const tags = yield* omics.listTagsForResource({
        resourceArn: store.referenceStoreArn,
      });
      expect(tags.tags["fixture"]).toBe("omics-reference-store");
      expect(tags.tags["alchemy::id"]).toBe("Refs");

      yield* stack.destroy();
      yield* assertReferenceStoreGone(store.referenceStoreId);
    }),
  { timeout: 180_000 },
);

const assertSequenceStoreGone = (id: string) =>
  Effect.gen(function* () {
    const gone = yield* omics.getSequenceStore({ id }).pipe(
      Effect.map(() => false),
      Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(true)),
    );
    if (!gone) {
      return yield* Effect.fail(
        new Error(`sequence store '${id}' still exists`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("3 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "SequenceStore: create, verify out-of-band, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { store } = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* SequenceStore("Reads", {
            description: "alchemy omics test sequence store",
            eTagAlgorithmFamily: "SHA256up",
            tags: { fixture: "omics-sequence-store" },
          });
          return { store };
        }),
      );

      expect(store.sequenceStoreId).toBeDefined();
      expect(store.sequenceStoreArn).toContain(":sequenceStore/");

      const live = yield* omics.getSequenceStore({
        id: store.sequenceStoreId,
      });
      expect(live.id).toBe(store.sequenceStoreId);
      expect(live.eTagAlgorithmFamily).toBe("SHA256up");

      yield* stack.destroy();
      yield* assertSequenceStoreGone(store.sequenceStoreId);
    }),
  { timeout: 180_000 },
);

const assertRunGroupGone = (id: string) =>
  Effect.gen(function* () {
    const gone = yield* omics.getRunGroup({ id }).pipe(
      Effect.map(() => false),
      Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(true)),
    );
    if (!gone) {
      return yield* Effect.fail(new Error(`run group '${id}' still exists`));
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("3 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "RunGroup: create, update limits, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create with an initial CPU cap.
      const first = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* RunGroup("Batch", {
            maxCpus: 4,
            maxRuns: 2,
            tags: { fixture: "omics-run-group" },
          });
          return { group };
        }),
      );
      expect(first.group.runGroupId).toBeDefined();
      const runGroupId = first.group.runGroupId;

      const created = yield* omics.getRunGroup({ id: runGroupId });
      expect(created.maxCpus).toBe(4);
      expect(created.maxRuns).toBe(2);

      // Update the CPU cap in place — same logical id, no replacement.
      const second = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* RunGroup("Batch", {
            maxCpus: 8,
            maxRuns: 2,
            tags: { fixture: "omics-run-group" },
          });
          return { group };
        }),
      );
      expect(second.group.runGroupId).toBe(runGroupId);

      const updated = yield* omics.getRunGroup({ id: runGroupId });
      expect(updated.maxCpus).toBe(8);

      yield* stack.destroy();
      yield* assertRunGroupGone(runGroupId);
    }),
  { timeout: 180_000 },
);

// ---------------------------------------------------------------------------
// Gated lifecycles — Workflow, AnnotationStore, and VariantStore each require
// async provisioning (and VariantStore a real reference genome ARN), so they
// are gated behind AWS_TEST_OMICS=1. VariantStore additionally reads a
// reference ARN from OMICS_REFERENCE_ARN.
//
// AnnotationStore/VariantStore CREATE additionally requires the account to be
// entitled for HealthOmics Analytics; without it the analytics- endpoint
// returns `AccessDeniedException: "Unable to determine service/operation name
// to be authorized"`. The ungated read probes above cover the endpoint routing
// and typed errors on every CI pass regardless of entitlement.
// ---------------------------------------------------------------------------

// A minimal WDL workflow definition, zipped in memory. A trivial workflow is
// accepted by HealthOmics without any genomics data.
const minimalWdl = `version 1.0
workflow HelloWorld {
  call Hello {}
}
task Hello {
  command { echo "hello" }
  output { String out = read_string(stdout()) }
  runtime { cpus: 1, memory: "1 GiB" }
}
`;

// Build a store-only (uncompressed) ZIP archive containing main.wdl. Kept
// dependency-free so the fixture needs no zip library.
const buildZip = (fileName: string, content: string): Uint8Array => {
  const enc = new TextEncoder();
  const nameBytes = enc.encode(fileName);
  const dataBytes = enc.encode(content);
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let crc = 0xffffffff;
  for (const b of dataBytes) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  crc = (crc ^ 0xffffffff) >>> 0;

  const chunks: number[] = [];
  const push32 = (v: number) => {
    chunks.push(
      v & 0xff,
      (v >>> 8) & 0xff,
      (v >>> 16) & 0xff,
      (v >>> 24) & 0xff,
    );
  };
  const push16 = (v: number) => chunks.push(v & 0xff, (v >>> 8) & 0xff);

  // Local file header.
  push32(0x04034b50);
  push16(20);
  push16(0);
  push16(0);
  push16(0);
  push16(0);
  push32(crc);
  push32(dataBytes.length);
  push32(dataBytes.length);
  push16(nameBytes.length);
  push16(0);
  for (const b of nameBytes) chunks.push(b);
  for (const b of dataBytes) chunks.push(b);
  const centralOffset = chunks.length;

  // Central directory header.
  push32(0x02014b50);
  push16(20);
  push16(20);
  push16(0);
  push16(0);
  push16(0);
  push16(0);
  push32(crc);
  push32(dataBytes.length);
  push32(dataBytes.length);
  push16(nameBytes.length);
  push16(0);
  push16(0);
  push16(0);
  push16(0);
  push32(0);
  push32(0);
  for (const b of nameBytes) chunks.push(b);
  const centralSize = chunks.length - centralOffset;

  // End of central directory.
  push32(0x06054b50);
  push16(0);
  push16(0);
  push16(1);
  push16(1);
  push32(centralSize);
  push32(centralOffset);
  push16(0);

  return Uint8Array.from(chunks);
};

const assertWorkflowGone = (id: string) =>
  Effect.gen(function* () {
    const status = yield* omics.getWorkflow({ id }).pipe(
      Effect.map((w) => w.status ?? "gone"),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed("gone" as const),
      ),
    );
    if (status !== "gone" && status !== "DELETED") {
      return yield* Effect.fail(
        new Error(`workflow '${id}' still exists (status: ${status})`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(12),
      ]),
    }),
  );

test.provider.skipIf(!process.env.AWS_TEST_OMICS)(
  "Workflow: create from inline WDL zip, verify ACTIVE, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const definitionZip = buildZip("main.wdl", minimalWdl);

      const { workflow } = yield* stack.deploy(
        Effect.gen(function* () {
          const workflow = yield* Workflow("Hello", {
            engine: "WDL",
            main: "main.wdl",
            definitionZip,
            tags: { fixture: "omics-workflow" },
          });
          return { workflow };
        }),
      );

      expect(workflow.workflowId).toBeDefined();
      expect(workflow.status).toBe("ACTIVE");

      const live = yield* omics.getWorkflow({ id: workflow.workflowId });
      expect(live.status).toBe("ACTIVE");

      yield* stack.destroy();
      yield* assertWorkflowGone(workflow.workflowId);
    }),
  { timeout: 240_000 },
);

const assertAnnotationStoreGone = (name: string) =>
  Effect.gen(function* () {
    const gone = yield* omics.getAnnotationStore({ name }).pipe(
      Effect.map(() => false),
      Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(true)),
    );
    if (!gone) {
      return yield* Effect.fail(
        new Error(`annotation store '${name}' still exists`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(24),
      ]),
    }),
  );

test.provider.skipIf(!process.env.AWS_TEST_OMICS)(
  "AnnotationStore: create TSV store, verify ACTIVE, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { store } = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* AnnotationStore("Annotations", {
            storeFormat: "TSV",
            storeOptions: {
              tsvStoreOptions: { annotationType: "GENERIC" },
            },
            tags: { fixture: "omics-annotation-store" },
          });
          return { store };
        }),
      );

      expect(store.annotationStoreId).toBeDefined();
      expect(store.status).toBe("ACTIVE");

      const live = yield* omics.getAnnotationStore({ name: store.name });
      expect(live.status).toBe("ACTIVE");
      expect(live.storeFormat).toBe("TSV");

      yield* stack.destroy();
      yield* assertAnnotationStoreGone(store.name);
    }),
  { timeout: 240_000 },
);

const assertVariantStoreGone = (name: string) =>
  Effect.gen(function* () {
    const gone = yield* omics.getVariantStore({ name }).pipe(
      Effect.map(() => false),
      Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(true)),
    );
    if (!gone) {
      return yield* Effect.fail(
        new Error(`variant store '${name}' still exists`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(24),
      ]),
    }),
  );

test.provider.skipIf(
  !process.env.AWS_TEST_OMICS || !process.env.OMICS_REFERENCE_ARN,
)(
  "VariantStore: create with reference, verify ACTIVE, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const referenceArn = process.env.OMICS_REFERENCE_ARN!;

      const { store } = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* VariantStore("Variants", {
            reference: { referenceArn },
            tags: { fixture: "omics-variant-store" },
          });
          return { store };
        }),
      );

      expect(store.variantStoreId).toBeDefined();
      expect(store.status).toBe("ACTIVE");

      const live = yield* omics.getVariantStore({ name: store.name });
      expect(live.status).toBe("ACTIVE");

      yield* stack.destroy();
      yield* assertVariantStoreGone(store.name);
    }),
  { timeout: 240_000 },
);
