import * as AWS from "@alchemy.run/aws";
import { PublicDnsNamespace } from "@alchemy.run/aws/CloudMap";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as sd from "@distilled.cloud/aws/servicediscovery";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// A public DNS namespace creates a real Route 53 public hosted zone. Route 53
// does not charge for a hosted zone deleted within 12 hours of creation, and
// the test destroys it immediately (~75s end to end). Opt out with
// AWS_TEST_CLOUDMAP_PUBLIC=0.
test.provider.skipIf(process.env.AWS_TEST_CLOUDMAP_PUBLIC === "0")(
  "create and delete public DNS namespace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const namespace = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* PublicDnsNamespace("TestPublicNamespace", {
            name: "alchemy-test-cloudmap.us",
            description: "public discovery test",
          });
        }),
      );

      expect(namespace.namespaceId).toBeDefined();
      expect(namespace.hostedZoneId).toBeDefined();

      const created = yield* sd
        .getNamespace({ Id: namespace.namespaceId })
        .pipe(Effect.map((r) => r.Namespace));
      expect(created?.Type).toBe("DNS_PUBLIC");

      yield* stack.destroy();
      const gone = yield* sd.getNamespace({ Id: namespace.namespaceId }).pipe(
        Effect.map(() => false),
        Effect.catchTag("NamespaceNotFound", () => Effect.succeed(true)),
      );
      expect(gone).toBe(true);
    }),
  { tags: ["provider:aws", "provider:aws:cloudmap", "live"], timeout: 240_000 },
);
