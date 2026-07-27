import * as AWS from "@/AWS";
import { Adapter } from "@/AWS/Textract/Adapter.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as textract from "@distilled.cloud/aws/textract";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Deterministic name unique to this test case (same on every run).
const adapterName = "alchemy-test-textract-adapter";

const getAdapter = (adapterId: string) =>
  textract
    .getAdapter({ AdapterId: adapterId })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

test.provider(
  "lifecycle: create adapter, update settings + tags, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create — a named QUERIES adapter with a description and user tags.
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Adapter("TestAdapter", {
            adapterName,
            featureTypes: ["QUERIES"],
            description: "alchemy adapter v1",
            autoUpdate: "DISABLED",
            tags: { env: "test" },
          });
        }),
      );
      expect(deployed.adapterId).toBeTruthy();
      expect(deployed.adapterName).toBe(adapterName);
      expect(deployed.featureTypes).toEqual(["QUERIES"]);
      expect(deployed.adapterArn).toContain(`:/adapters/${deployed.adapterId}`);

      // Out-of-band verification via distilled.
      const created = yield* getAdapter(deployed.adapterId);
      expect(created?.AdapterName).toBe(adapterName);
      expect(created?.Description).toBe("alchemy adapter v1");
      expect(created?.AutoUpdate).toBe("DISABLED");
      expect(created?.Tags?.env).toBe("test");
      // Internal ownership branding.
      expect(created?.Tags?.["alchemy::id"]).toBe("TestAdapter");

      // Canonical list() coverage.
      const provider = yield* Provider.findProvider(Adapter);
      const all = yield* provider.list();
      expect(all.some((a) => a.adapterId === deployed.adapterId)).toBe(true);

      // Update — description, autoUpdate, and tags are all mutable in place.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Adapter("TestAdapter", {
            adapterName,
            featureTypes: ["QUERIES"],
            description: "alchemy adapter v2",
            autoUpdate: "ENABLED",
            tags: { env: "test2", extra: "1" },
          });
        }),
      );
      // Same physical adapter (update, not replace).
      expect(updated.adapterId).toBe(deployed.adapterId);

      const observed = yield* getAdapter(deployed.adapterId);
      expect(observed?.Description).toBe("alchemy adapter v2");
      expect(observed?.AutoUpdate).toBe("ENABLED");
      expect(observed?.Tags?.env).toBe("test2");
      expect(observed?.Tags?.extra).toBe("1");

      // Destroy — the adapter is gone.
      yield* stack.destroy();
      const after = yield* getAdapter(deployed.adapterId);
      expect(after).toBeUndefined();
    }),
  { timeout: 180_000 },
);
