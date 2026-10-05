import {
  Credential,
  validateCredential,
  type CredentialScope,
} from "@/Neon/Credential";
import { Branch } from "@/Neon/Branch";
import { Project } from "@/Neon/Project";
import { providers } from "@/Neon/Providers";
import * as Test from "@/Test/Alchemy";
import * as SDK from "@distilled.cloud/neon";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: providers() });

test.provider(
  "credential reveals without rotation and replaces scopes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (scopes: CredentialScope[]) =>
        stack.deploy(
          Effect.gen(function* () {
            const project = yield* Project("CredentialProject", {
              region: "aws-us-east-2",
            });
            const credential = yield* Credential("Reader", { project, scopes });
            const named = yield* Credential("Named", {
              project,
              scopes,
              name: "named-storage-credential",
            });
            return { project, credential, named };
          }),
        );
      const first = yield* deploy(["storage:read"]);
      const second = yield* deploy(["storage:read"]);
      expect(second.credential.tokenId).toBe(first.credential.tokenId);
      const scope = {
        project_id: first.credential.projectId,
        branch_id: first.credential.branchId,
      };
      const listed = yield* SDK.listCredentials(scope);
      expect(
        listed.credentials.filter(
          (credential) => credential.token_id === first.credential.tokenId,
        ),
      ).toHaveLength(1);
      const revealed = yield* SDK.revealCredential({
        ...scope,
        token_id: first.credential.tokenId,
      });
      expect(
        Redacted.value(first.credential.apiToken) ===
          (Redacted.isRedacted(revealed.api_token)
            ? Redacted.value(revealed.api_token)
            : revealed.api_token),
      ).toBe(true);
      expect(Redacted.isRedacted(second.credential.s3SecretAccessKey)).toBe(
        true,
      );
      const changed = yield* deploy(["storage:write"]);
      expect(changed.credential.tokenId).not.toBe(first.credential.tokenId);
      expect(changed.named.tokenId).not.toBe(first.named.tokenId);
      expect(changed.named.name).toBe(first.named.name);
      expect(
        (yield* SDK.listCredentials(scope)).credentials.some(
          (credential) =>
            credential.token_id === first.named.tokenId &&
            !credential.revoked_at,
        ),
      ).toBe(false);
      const old = yield* SDK.revealCredential({
        ...scope,
        token_id: first.credential.tokenId,
      }).pipe(
        Effect.as(false),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
      );
      expect(old).toBe(true);
      yield* stack.destroy();
      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:neon",
      "provider:neon:credential",
      "provider:neon:project",
      "live",
    ],
    timeout: 120_000,
  },
);

test.provider(
  "credential override validates ancestry scopes and out-of-band revocation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = (
        scopes: CredentialScope[] = ["storage:read", "storage:write"],
      ) =>
        Effect.gen(function* () {
          const project = yield* Project("LineageProject", {
            region: "aws-us-east-2",
          });
          const left = yield* Branch("Left", { project });
          const child = yield* Branch("Child", { project, parentBranch: left });
          const sibling = yield* Branch("Sibling", { project });
          const credential = yield* Credential("Writer", {
            branch: left,
            scopes,
          });
          return { project, left, child, sibling, credential };
        });
      const first = yield* stack.deploy(program());
      yield* validateCredential(first.credential, first.child, "storage:read");
      yield* validateCredential(first.credential, first.left, "storage:write");
      const sibling = yield* validateCredential(
        first.credential,
        first.sibling,
        "storage:read",
      ).pipe(Effect.result);
      expect(Result.isFailure(sibling)).toBe(true);
      if (Result.isFailure(sibling))
        expect(sibling.failure._tag).toBe("CredentialRecoveryError");
      const scope = yield* validateCredential(
        first.credential,
        first.left,
        "ai_gateway:invoke",
      ).pipe(Effect.result);
      expect(Result.isFailure(scope)).toBe(true);
      yield* SDK.revokeCredential({
        project_id: first.credential.projectId,
        branch_id: first.credential.branchId,
        token_id: first.credential.tokenId,
      });
      // Reordering equal scopes schedules reconciliation without changing permissions.
      const recovered = yield* stack.deploy(
        program(["storage:write", "storage:read"]),
      );
      expect(recovered.credential.tokenId).not.toBe(first.credential.tokenId);
      expect(recovered.credential.name).toBe(first.credential.name);
      yield* stack.destroy();
      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:neon",
      "provider:neon:branch",
      "provider:neon:credential",
      "provider:neon:project",
      "live",
    ],
    timeout: 120_000,
  },
);
