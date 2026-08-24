import * as AWS from "@/AWS";
import { PublicDnsNamespace } from "@/AWS/CloudMap";
import * as Test from "@/Test/Alchemy";
import * as sd from "@distilled.cloud/aws/servicediscovery";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// A public DNS namespace creates a real Route 53 public hosted zone (billed
// while it exists, and only useful with a domain you control), so the live
// lifecycle is opt-in.
test.provider.skipIf(!process.env.AWS_TEST_CLOUDMAP_PUBLIC)(
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
  { timeout: 240_000 },
);
