import * as AWS from "@/AWS";
import { ConnectorProfile } from "@/AWS/AppFlow";
import * as Test from "@/Test/Alchemy";
import * as appflow from "@distilled.cloud/aws/appflow";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Every AppFlow connector validates the vendor connection at
// createConnectorProfile time (verified live for Salesforce and Snowflake),
// so a connector profile cannot be provisioned without real vendor
// credentials. The ungated probes below pin the typed error the API returns
// for an unreachable/unauthorized connector — the exact failure mode the
// gated lifecycle hits without credentials.

test.provider(
  "createConnectorProfile with an unreachable connector fails with a typed error",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        appflow.createConnectorProfile({
          connectorProfileName: "alchemy-test-appflow-cp-probe",
          connectorType: "Salesforce",
          connectionMode: "Public",
          connectorProfileConfig: {
            connectorProfileProperties: {
              Salesforce: {
                instanceUrl: "https://invalid-example.my.salesforce.com",
              },
            },
            connectorProfileCredentials: {
              Salesforce: {
                accessToken: "bogus-access-token",
                refreshToken: "bogus-refresh-token",
              },
            },
          },
        }),
      );
      // ConnectorServerException (unreachable host) is the observed tag;
      // ConnectorAuthenticationException covers a reachable-but-unauthorized
      // vendor. Both are typed via the distilled patch for this operation.
      expect([
        "ConnectorServerException",
        "ConnectorAuthenticationException",
      ]).toContain(error._tag);
    }),
);

test.provider(
  "describeConnectorProfiles returns an empty list for an unknown name",
  () =>
    Effect.gen(function* () {
      const response = yield* appflow.describeConnectorProfiles({
        connectorProfileNames: ["alchemy-test-appflow-cp-missing"],
      });
      expect(response.connectorProfileDetails ?? []).toHaveLength(0);
    }),
);

// Full lifecycle requires real vendor credentials (human-in-the-loop OAuth
// or a live Snowflake/Redshift endpoint). Entitled runs supply them via env:
//   AWS_TEST_APPFLOW_CONNECTOR=1
//   APPFLOW_SALESFORCE_INSTANCE_URL, APPFLOW_SALESFORCE_ACCESS_TOKEN,
//   APPFLOW_SALESFORCE_REFRESH_TOKEN
test.provider.skipIf(!process.env.AWS_TEST_APPFLOW_CONNECTOR)(
  "create, update, and destroy a Salesforce connector profile",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const props = {
        connectorProfileName: "alchemy-test-appflow-cp",
        connectorType: "Salesforce" as const,
        connectionMode: "Public" as const,
        connectorProfileConfig: {
          connectorProfileProperties: {
            Salesforce: {
              instanceUrl: process.env.APPFLOW_SALESFORCE_INSTANCE_URL!,
            },
          },
          connectorProfileCredentials: {
            Salesforce: {
              accessToken: process.env.APPFLOW_SALESFORCE_ACCESS_TOKEN!,
              refreshToken: process.env.APPFLOW_SALESFORCE_REFRESH_TOKEN!,
            },
          },
        },
      };

      const created = yield* stack.deploy(
        ConnectorProfile("Salesforce", props),
      );
      expect(created.connectorProfileName).toBe("alchemy-test-appflow-cp");
      expect(created.connectorProfileArn).toContain(":appflow:");
      expect(created.connectorType).toBe("Salesforce");

      // Out-of-band verification.
      const described = yield* appflow.describeConnectorProfiles({
        connectorProfileNames: ["alchemy-test-appflow-cp"],
      });
      expect(described.connectorProfileDetails ?? []).toHaveLength(1);

      // No-op redeploy keeps the same ARN (credentials are re-pushed since
      // they cannot be read back).
      const noop = yield* stack.deploy(ConnectorProfile("Salesforce", props));
      expect(noop.connectorProfileArn).toBe(created.connectorProfileArn);

      yield* stack.destroy();
      const gone = yield* appflow.describeConnectorProfiles({
        connectorProfileNames: ["alchemy-test-appflow-cp"],
      });
      expect(gone.connectorProfileDetails ?? []).toHaveLength(0);
    }),
  { timeout: 120_000 },
);
