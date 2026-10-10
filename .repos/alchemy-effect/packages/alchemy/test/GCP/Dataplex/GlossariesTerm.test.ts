import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dataplex from "@distilled.cloud/gcp/dataplex_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { withDataplexSlot } from "./quota.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  dataplex.getProjectsLocationsGlossariesTerms({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!!process.env.FAST)(
  "create, update, and delete a glossary term",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const glossary = yield* GCP.Dataplex.Glossary("BusinessTerms", {
            location: "us-central1",
            displayName: "terms parent",
            labels: { env: "test" },
          });
          const term = yield* GCP.Dataplex.GlossariesTerm("Customer", {
            glossary: glossary.name,
            displayName: "Customer",
            description: "a paying account",
            labels: { env: "test" },
          });
          return { glossary, term };
        }),
      );

      expect(created.term.name).toContain("/terms/");
      expect(created.term.termId).toEqual(expect.any(String));
      expect(created.term.glossary).toEqual(created.glossary.name);
      expect(created.term.displayName).toEqual("Customer");
      expect(created.term.description).toEqual("a paying account");
      expect(created.term.labels).toMatchObject({ env: "test" });

      const fetched = yield* dataplex.getProjectsLocationsGlossariesTerms({
        name: created.term.name,
      });
      expect(fetched.name).toEqual(created.term.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const glossary = yield* GCP.Dataplex.Glossary("BusinessTerms", {
            glossaryId: created.glossary.glossaryId,
            location: "us-central1",
            displayName: "terms parent",
            labels: { env: "test" },
          });
          const term = yield* GCP.Dataplex.GlossariesTerm("Customer", {
            glossary: glossary.name,
            termId: created.term.termId,
            displayName: "Customer account",
            description: "updated term",
            labels: { env: "prod", team: "data" },
          });
          return { glossary, term };
        }),
      );

      expect(updated.term.name).toEqual(created.term.name);
      expect(updated.term.displayName).toEqual("Customer account");
      expect(updated.term.description).toEqual("updated term");
      expect(updated.term.labels).toMatchObject({ env: "prod", team: "data" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.term.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, withDataplexSlot),
  { tags: ["provider:gcp", "provider:gcp:dataplex", "live"], timeout: 900_000 },
);
