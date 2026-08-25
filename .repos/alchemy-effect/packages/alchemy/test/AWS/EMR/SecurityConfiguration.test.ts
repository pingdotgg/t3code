import * as AWS from "@/AWS";
import { SecurityConfiguration } from "@/AWS/EMR/SecurityConfiguration.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as emr from "@distilled.cloud/aws/emr";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const configName = "alchemy-test-emr-security-configuration";

// Ungated typed-error probe: proves the distilled emr error union carries the
// SecurityConfigurationNotFound tag this provider's read/delete paths depend
// on (EMR overloads InvalidRequestException with a message-only distinction).
test.provider(
  "describeSecurityConfiguration on a nonexistent name fails with SecurityConfigurationNotFound",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        emr.describeSecurityConfiguration({
          Name: "alchemy-emr-nonexistent-probe",
        }),
      );
      expect(error._tag).toBe("SecurityConfigurationNotFound");
    }),
);

const imdsDocument = {
  InstanceMetadataServiceConfiguration: {
    MinimumInstanceMetadataServiceVersion: 2,
    HttpPutResponseHopLimit: 1,
  },
};

const encryptionDocument = {
  EncryptionConfiguration: {
    EnableInTransitEncryption: false,
    EnableAtRestEncryption: false,
  },
};

test.provider(
  "lifecycle: create, update content in place, replace on rename, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create.
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* SecurityConfiguration("Config", {
            securityConfigurationName: configName,
            securityConfiguration: imdsDocument,
          });
        }),
      );
      expect(deployed.securityConfigurationName).toBe(configName);

      // Out-of-band verification via distilled.
      const created = yield* emr.describeSecurityConfiguration({
        Name: configName,
      });
      expect(JSON.parse(created.SecurityConfiguration ?? "{}")).toEqual(
        imdsDocument,
      );

      // Canonical list() coverage.
      const provider = yield* Provider.findProvider(SecurityConfiguration);
      const all = yield* provider.list();
      expect(all.some((c) => c.securityConfigurationName === configName)).toBe(
        true,
      );

      // Update content in place — the document is immutable in EMR, so the
      // provider converges by deleting and recreating under the same name
      // (no replacement from the engine's perspective).
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* SecurityConfiguration("Config", {
            securityConfigurationName: configName,
            securityConfiguration: encryptionDocument,
          });
        }),
      );
      const updated = yield* emr.describeSecurityConfiguration({
        Name: configName,
      });
      expect(JSON.parse(updated.SecurityConfiguration ?? "{}")).toEqual(
        encryptionDocument,
      );

      // Rename — diff returns replace; the new name exists, the old is gone.
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* SecurityConfiguration("Config", {
            securityConfigurationName: `${configName}-renamed`,
            securityConfiguration: encryptionDocument,
          });
        }),
      );
      const renamed = yield* emr.describeSecurityConfiguration({
        Name: `${configName}-renamed`,
      });
      expect(renamed.Name).toBe(`${configName}-renamed`);
      const oldGone = yield* Effect.flip(
        emr.describeSecurityConfiguration({ Name: configName }),
      );
      expect(oldGone._tag).toBe("SecurityConfigurationNotFound");

      // Destroy — verify gone out of band.
      yield* stack.destroy();
      const afterDestroy = yield* Effect.flip(
        emr.describeSecurityConfiguration({ Name: `${configName}-renamed` }),
      );
      expect(afterDestroy._tag).toBe("SecurityConfigurationNotFound");
    }),
  { timeout: 120_000 },
);
