import * as AWS from "@/AWS";
import { Connection } from "@/AWS/CodeConnections/Connection.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as codeconnections from "@distilled.cloud/aws/codeconnections";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Connection names are capped at 32 chars.
const connectionName = "alchemy-test-conn";

test.provider(
  "lifecycle: create GitHub connection (PENDING), destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create — the connection is created in PENDING; completing the OAuth
      // handshake is a manual console step with no API, so PENDING is the
      // only state we can assert without human interaction.
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Connection("GitHubConn", {
            connectionName,
            providerType: "GitHub",
          });
        }),
      );
      expect(deployed.connectionArn).toContain(":connection/");
      expect(deployed.connectionStatus).toBe("PENDING");
      expect(deployed.providerType).toBe("GitHub");

      // Out-of-band verification via distilled.
      const created = yield* codeconnections.getConnection({
        ConnectionArn: deployed.connectionArn,
      });
      expect(created.Connection?.ConnectionName).toBe(connectionName);
      expect(created.Connection?.ConnectionStatus).toBe("PENDING");
      expect(created.Connection?.ProviderType).toBe("GitHub");

      // Canonical list() coverage.
      const provider = yield* Provider.findProvider(Connection);
      const all = yield* provider.list();
      expect(all.some((c) => c.connectionArn === deployed.connectionArn)).toBe(
        true,
      );

      // Destroy — connection is deleted; verify it is gone out-of-band.
      yield* stack.destroy();
      const after = yield* codeconnections
        .getConnection({ ConnectionArn: deployed.connectionArn })
        .pipe(
          Effect.map((res) => res.Connection),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      expect(after).toBeUndefined();
    }),
  { timeout: 120_000 },
);
