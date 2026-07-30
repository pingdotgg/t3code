import * as AWS from "@/AWS";
import { HttpNamespace } from "@/AWS/CloudMap";
import * as Test from "@/Test/Alchemy";
import * as sd from "@distilled.cloud/aws/servicediscovery";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const findNamespace = (namespaceId: string) =>
  sd.getNamespace({ Id: namespaceId }).pipe(
    Effect.map((r) => r.Namespace),
    Effect.catchTag("NamespaceNotFound", () => Effect.succeed(undefined)),
  );

class NamespaceStillExists extends Data.TaggedError("NamespaceStillExists")<{
  readonly namespaceId: string;
}> {}

const assertNamespaceDeleted = (namespaceId: string) =>
  findNamespace(namespaceId).pipe(
    Effect.flatMap((namespace) =>
      namespace === undefined
        ? Effect.void
        : Effect.fail(new NamespaceStillExists({ namespaceId })),
    ),
    Effect.retry({
      while: (e) => e._tag === "NamespaceStillExists",
      schedule: Schedule.max([
        Schedule.spaced("3 seconds"),
        Schedule.recurs(20),
      ]),
    }),
  );

test.provider(
  "create, update description, delete HTTP namespace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const namespace = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* HttpNamespace("TestHttpNamespace", {
            description: "initial description",
            tags: { Environment: "test" },
          });
        }),
      );

      expect(namespace.namespaceId).toBeDefined();
      expect(namespace.namespaceArn).toContain(":namespace/");
      expect(namespace.httpName).toBeDefined();

      // out-of-band verification via distilled
      const created = yield* findNamespace(namespace.namespaceId);
      expect(created?.Type).toBe("HTTP");
      expect(created?.Description).toBe("initial description");
      const tags = yield* sd
        .listTagsForResource({ ResourceARN: namespace.namespaceArn })
        .pipe(
          Effect.map((r) =>
            Object.fromEntries((r.Tags ?? []).map((t) => [t.Key, t.Value])),
          ),
        );
      expect(tags.Environment).toBe("test");
      expect(tags["alchemy::id"]).toBe("TestHttpNamespace");

      // update the description (async namespace update operation)
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* HttpNamespace("TestHttpNamespace", {
            description: "updated description",
            tags: { Environment: "test", Extra: "yes" },
          });
        }),
      );
      expect(updated.namespaceId).toBe(namespace.namespaceId);
      expect(updated.namespaceArn).toBe(namespace.namespaceArn);

      const afterUpdate = yield* findNamespace(namespace.namespaceId);
      expect(afterUpdate?.Description).toBe("updated description");
      const tagsAfter = yield* sd
        .listTagsForResource({ ResourceARN: namespace.namespaceArn })
        .pipe(
          Effect.map((r) =>
            Object.fromEntries((r.Tags ?? []).map((t) => [t.Key, t.Value])),
          ),
        );
      expect(tagsAfter.Extra).toBe("yes");

      yield* stack.destroy();
      yield* assertNamespaceDeleted(namespace.namespaceId);
    }),
  { timeout: 240_000 },
);

test.provider(
  "explicit name and replacement on rename",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* HttpNamespace("NamedHttpNamespace", {
            name: "alchemy-test-cloudmap-http-a",
          });
        }),
      );
      expect(first.namespaceName).toBe("alchemy-test-cloudmap-http-a");

      // renaming triggers a replacement: new physical namespace, old gone
      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* HttpNamespace("NamedHttpNamespace", {
            name: "alchemy-test-cloudmap-http-b",
          });
        }),
      );
      expect(second.namespaceName).toBe("alchemy-test-cloudmap-http-b");
      expect(second.namespaceId).not.toBe(first.namespaceId);

      yield* assertNamespaceDeleted(first.namespaceId);

      yield* stack.destroy();
      yield* assertNamespaceDeleted(second.namespaceId);
    }),
  { timeout: 240_000 },
);
