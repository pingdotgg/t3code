import * as AWS from "@/AWS";
import {
  ServiceSpecificCredential,
  SigningCertificate,
  SSHPublicKey,
  User,
} from "@/AWS/IAM";
import * as Test from "@/Test/Vitest";
import * as IAM from "@distilled.cloud/aws/iam";
import { describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { testCertificateBody, testSshPublicKey } from "./fixtures.ts";

const { test } = Test.make({ providers: AWS.providers() });

describe("AWS.IAM credential resources", () => {
  test.provider(
    "create, update, and delete a service-specific credential",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const user = yield* User("CredentialOwner", {});
            const credential = yield* ServiceSpecificCredential(
              "ServiceCredential",
              {
                userName: user.userName,
                serviceName: "codecommit.amazonaws.com",
                status: "Active",
              },
            );
            return { user, credential };
          }),
        );

        expect(deployed.credential.servicePassword).toBeDefined();

        const created = yield* IAM.listServiceSpecificCredentials({
          UserName: deployed.user.userName,
          ServiceName: deployed.credential.serviceName,
        });
        expect(
          created.ServiceSpecificCredentials?.some(
            (entry) =>
              entry.ServiceSpecificCredentialId ===
              deployed.credential.serviceSpecificCredentialId,
          ),
        ).toBe(true);

        yield* stack.deploy(
          Effect.gen(function* () {
            const user = yield* User("CredentialOwner", {});
            yield* ServiceSpecificCredential("ServiceCredential", {
              userName: user.userName,
              serviceName: "codecommit.amazonaws.com",
              status: "Inactive",
            });
          }),
        );

        const updated = yield* IAM.listServiceSpecificCredentials({
          UserName: deployed.user.userName,
          ServiceName: deployed.credential.serviceName,
        });
        const metadata = updated.ServiceSpecificCredentials?.find(
          (entry) =>
            entry.ServiceSpecificCredentialId ===
            deployed.credential.serviceSpecificCredentialId,
        );
        expect(metadata?.Status).toBe("Inactive");

        yield* stack.destroy();

        const deleted = yield* IAM.listServiceSpecificCredentials({
          UserName: deployed.user.userName,
          ServiceName: deployed.credential.serviceName,
        }).pipe(Effect.option);
        expect(
          deleted._tag === "None" ||
            !deleted.value.ServiceSpecificCredentials?.some(
              (entry) =>
                entry.ServiceSpecificCredentialId ===
                deployed.credential.serviceSpecificCredentialId,
            ),
        ).toBe(true);
      }),
  );

  test.provider(
    "create, update, and delete SSH and signing credentials for a user",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const user = yield* User("CredentialUser", {});
            const sshKey = yield* SSHPublicKey("UserSshKey", {
              userName: user.userName,
              sshPublicKeyBody: testSshPublicKey,
              status: "Active",
            });
            const signingCertificate = yield* SigningCertificate(
              "UserSigningCertificate",
              {
                userName: user.userName,
                certificateBody: testCertificateBody,
                status: "Active",
              },
            );
            return { user, sshKey, signingCertificate };
          }),
        );

        const createdKey = yield* IAM.getSSHPublicKey({
          UserName: deployed.user.userName,
          SSHPublicKeyId: deployed.sshKey.sshPublicKeyId,
          Encoding: "SSH",
        });
        expect(createdKey.SSHPublicKey?.Status).toBe("Active");

        const createdCerts = yield* IAM.listSigningCertificates({
          UserName: deployed.user.userName,
        });
        expect(
          createdCerts.Certificates.some(
            (entry) =>
              entry.CertificateId === deployed.signingCertificate.certificateId,
          ),
        ).toBe(true);

        yield* stack.deploy(
          Effect.gen(function* () {
            const user = yield* User("CredentialUser", {});
            yield* SSHPublicKey("UserSshKey", {
              userName: user.userName,
              sshPublicKeyBody: testSshPublicKey,
              status: "Inactive",
            });
            yield* SigningCertificate("UserSigningCertificate", {
              userName: user.userName,
              certificateBody: testCertificateBody,
              status: "Inactive",
            });
          }),
        );

        const updatedKey = yield* IAM.getSSHPublicKey({
          UserName: deployed.user.userName,
          SSHPublicKeyId: deployed.sshKey.sshPublicKeyId,
          Encoding: "SSH",
        });
        expect(updatedKey.SSHPublicKey?.Status).toBe("Inactive");

        const updatedCerts = yield* IAM.listSigningCertificates({
          UserName: deployed.user.userName,
        });
        const updatedCert = updatedCerts.Certificates.find(
          (entry) =>
            entry.CertificateId === deployed.signingCertificate.certificateId,
        );
        expect(updatedCert?.Status).toBe("Inactive");

        yield* stack.destroy();

        const deletedKey = yield* IAM.getSSHPublicKey({
          UserName: deployed.user.userName,
          SSHPublicKeyId: deployed.sshKey.sshPublicKeyId,
          Encoding: "SSH",
        }).pipe(Effect.option);
        expect(deletedKey._tag).toBe("None");

        const deletedCerts = yield* IAM.listSigningCertificates({
          UserName: deployed.user.userName,
        }).pipe(Effect.option);
        expect(
          deletedCerts._tag === "None" ||
            !deletedCerts.value.Certificates.some(
              (entry) =>
                entry.CertificateId ===
                deployed.signingCertificate.certificateId,
            ),
        ).toBe(true);
      }),
  );
});
