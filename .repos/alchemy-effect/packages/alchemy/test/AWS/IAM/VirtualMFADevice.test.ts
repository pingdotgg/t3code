import * as AWS from "@/AWS";
import { VirtualMFADevice } from "@/AWS/IAM";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

describe("AWS.IAM.VirtualMFADevice", () => {
  test.provider("list enumerates the deployed virtual MFA device", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const device = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* VirtualMFADevice("ListVirtualMfaDevice", {
            tags: {
              env: "test",
            },
          });
        }),
      );

      const provider = yield* Provider.findProvider(VirtualMFADevice);
      const all = yield* provider.list();

      const found = all.find(
        (entry) => entry.serialNumber === device.serialNumber,
      );
      expect(found).toBeDefined();
      expect(found?.tags).toMatchObject({ env: "test" });

      yield* stack.destroy();

      // IAM has no get-virtual-mfa-device API; re-list exhaustively and
      // assert the device's serial number no longer appears.
      const remaining = yield* provider.list();
      expect(
        remaining.some((entry) => entry.serialNumber === device.serialNumber),
      ).toBe(false);
    }),
  );
});
