import * as AWS from "@/AWS";
import { ServerCertificate, VirtualMFADevice } from "@/AWS/IAM";
import * as Test from "@/Test/Vitest";
import * as IAM from "@distilled.cloud/aws/iam";
import { describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { testCertificateBody, testPrivateKey } from "./fixtures.ts";

const { test } = Test.make({ providers: AWS.providers() });

describe("AWS.IAM device and server certificate resources", () => {
  test.provider("create, update, and delete a server certificate", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const certificate = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ServerCertificate("ServerCertificate", {
            certificateBody: testCertificateBody,
            privateKey: testPrivateKey,
            tags: {
              env: "test",
            },
          });
        }),
      );

      const created = yield* IAM.getServerCertificate({
        ServerCertificateName: certificate.serverCertificateName,
      });
      expect(
        created.ServerCertificate.ServerCertificateMetadata
          .ServerCertificateName,
      ).toBe(certificate.serverCertificateName);

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ServerCertificate("ServerCertificate", {
            certificateBody: testCertificateBody,
            privateKey: testPrivateKey,
            tags: {
              env: "prod",
            },
          });
        }),
      );

      const updatedTags = yield* IAM.listServerCertificateTags({
        ServerCertificateName: certificate.serverCertificateName,
      });
      expect(
        Object.fromEntries(
          (updatedTags.Tags ?? []).map((tag) => [tag.Key, tag.Value]),
        ),
      ).toMatchObject({
        env: "prod",
      });

      yield* stack.destroy();

      const deleted = yield* IAM.getServerCertificate({
        ServerCertificateName: certificate.serverCertificateName,
      }).pipe(Effect.option);
      expect(deleted._tag).toBe("None");
    }),
  );

  test.provider(
    "create, update, and delete an unassigned virtual MFA device",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const device = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* VirtualMFADevice("VirtualMfaDevice", {
              tags: {
                env: "test",
              },
            });
          }),
        );

        expect(device.base32StringSeed).toBeDefined();
        expect(device.qrCodePNG).toBeDefined();

        const created = yield* IAM.listVirtualMFADevices({
          AssignmentStatus: "Unassigned",
        });
        expect(
          created.VirtualMFADevices.some(
            (entry) => entry.SerialNumber === device.serialNumber,
          ),
        ).toBe(true);

        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* VirtualMFADevice("VirtualMfaDevice", {
              tags: {
                env: "prod",
              },
            });
          }),
        );

        const updatedTags = yield* IAM.listMFADeviceTags({
          SerialNumber: device.serialNumber,
        });
        expect(
          Object.fromEntries(
            (updatedTags.Tags ?? []).map((tag) => [tag.Key, tag.Value]),
          ),
        ).toMatchObject({
          env: "prod",
        });

        yield* stack.destroy();

        const deleted = yield* IAM.listVirtualMFADevices({
          AssignmentStatus: "Unassigned",
        }).pipe(Effect.option);
        expect(
          deleted._tag === "None" ||
            !deleted.value.VirtualMFADevices.some(
              (entry) => entry.SerialNumber === device.serialNumber,
            ),
        ).toBe(true);
      }),
  );
});
