import * as AWS from "@/AWS";
import { Host } from "@/AWS/CodeConnections/Host.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as codeconnections from "@distilled.cloud/aws/codeconnections";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Host names are capped at 64 chars.
const hostName = "alchemy-test-host";

test.provider(
  "lifecycle: create GHES host (PENDING), update endpoint, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create — the host is created in PENDING; completing the setup is a
      // manual console step with no API, so PENDING is the only state we can
      // assert without human interaction. The endpoint is not probed at
      // creation time.
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Host("GHEHost", {
            name: hostName,
            providerType: "GitHubEnterpriseServer",
            providerEndpoint: "https://ghe.example.com",
          });
        }),
      );
      expect(deployed.hostArn).toContain(":host/");
      expect(deployed.hostStatus).toBe("PENDING");
      expect(deployed.providerType).toBe("GitHubEnterpriseServer");
      expect(deployed.providerEndpoint).toBe("https://ghe.example.com");

      // Out-of-band verification via distilled.
      const created = yield* codeconnections.getHost({
        HostArn: deployed.hostArn,
      });
      expect(created.Name).toBe(hostName);
      expect(created.ProviderEndpoint).toBe("https://ghe.example.com");

      // Update — the provider endpoint is mutable via UpdateHost.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Host("GHEHost", {
            name: hostName,
            providerType: "GitHubEnterpriseServer",
            providerEndpoint: "https://ghe2.example.com",
          });
        }),
      );
      // Same host (update, not replace)…
      expect(updated.hostArn).toBe(deployed.hostArn);
      // …with the new endpoint observed out-of-band.
      const afterUpdate = yield* codeconnections.getHost({
        HostArn: deployed.hostArn,
      });
      expect(afterUpdate.ProviderEndpoint).toBe("https://ghe2.example.com");

      // Canonical list() coverage.
      const provider = yield* Provider.findProvider(Host);
      const all = yield* provider.list();
      expect(all.some((h) => h.hostArn === deployed.hostArn)).toBe(true);

      // Destroy — host is deleted; verify it is gone out-of-band.
      yield* stack.destroy();
      const after = yield* codeconnections
        .getHost({ HostArn: deployed.hostArn })
        .pipe(
          Effect.map((res) => res.Name),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      expect(after).toBeUndefined();
    }),
  { timeout: 120_000 },
);
