import * as AWS from "@/AWS";
import { Terminology } from "@/AWS/Translate/Terminology.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as translate from "@distilled.cloud/aws/translate";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const terminologyName = "alchemy-test-translate-terminology";

// Checked-in CSV fixtures — never generated at test time. The first row is
// the language-code header; each subsequent row is a term pair.
const CSV_V1 = ["en,es", "Alchemy,Alquimia"].join("\n");
const CSV_V2 = ["en,es", "Alchemy,Alquimia", "Stack,Pila"].join("\n");

const getTerminology = (name: string) =>
  translate
    .getTerminology({ Name: name })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

test.provider(
  "lifecycle: create named terminology, update terms, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create — a named CSV terminology with a single term pair.
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Terminology("TestGlossary", {
            terminologyName,
            file: CSV_V1,
            format: "CSV",
            description: "alchemy translate terminology test",
            tags: { purpose: "alchemy-test" },
          });
        }),
      );
      expect(deployed.terminologyName).toBe(terminologyName);
      expect(deployed.terminologyArn).toContain(
        `:terminology/${terminologyName}`,
      );
      expect(deployed.sourceLanguageCode).toBe("en");
      expect(deployed.targetLanguageCodes).toContain("es");
      expect(deployed.termCount).toBe(1);

      // Out-of-band verification via distilled — including tag sync.
      const created = yield* getTerminology(terminologyName);
      expect(created?.TerminologyProperties?.TermCount).toBe(1);
      const tags = yield* translate.listTagsForResource({
        ResourceArn: deployed.terminologyArn,
      });
      const tagRecord = Object.fromEntries(
        (tags.Tags ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(tagRecord.purpose).toBe("alchemy-test");
      expect(tagRecord["alchemy::stack"]).toBeTruthy();

      // Canonical list() coverage.
      const provider = yield* Provider.findProvider(Terminology);
      const all = yield* provider.list();
      expect(all.some((t) => t.terminologyName === terminologyName)).toBe(true);

      // Update — ImportTerminology is an OVERWRITE upsert; the second term
      // pair lands in place. TermCount converges shortly after import.
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Terminology("TestGlossary", {
            terminologyName,
            file: CSV_V2,
            format: "CSV",
            description: "alchemy translate terminology test",
            tags: { purpose: "alchemy-test" },
          });
        }),
      );
      const updated = yield* getTerminology(terminologyName).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: (r): boolean => r?.TerminologyProperties?.TermCount === 2,
          times: 10,
        }),
      );
      expect(updated?.TerminologyProperties?.TermCount).toBe(2);

      // Destroy — the terminology is gone.
      yield* stack.destroy();
      const after = yield* getTerminology(terminologyName);
      expect(after).toBeUndefined();
    }),
  { timeout: 180_000 },
);

test.provider(
  "generates a valid name when terminologyName is omitted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Terminology("GeneratedName", {
            file: CSV_V1,
            format: "CSV",
          });
        }),
      );
      // Translate constrains names to ^([A-Za-z0-9-]_?)+$.
      expect(deployed.terminologyName).toMatch(/^[A-Za-z0-9-]+$/);

      const created = yield* getTerminology(deployed.terminologyName);
      expect(created).toBeDefined();

      yield* stack.destroy();
      const after = yield* getTerminology(deployed.terminologyName);
      expect(after).toBeUndefined();
    }),
  { timeout: 180_000 },
);
