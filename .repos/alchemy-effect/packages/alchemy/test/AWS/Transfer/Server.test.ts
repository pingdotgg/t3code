import * as AWS from "@/AWS";
import { Role } from "@/AWS/IAM";
import { Server, User } from "@/AWS/Transfer";
import * as Test from "@/Test/Alchemy";
import * as transfer from "@distilled.cloud/aws/transfer";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: proves the distilled error union carries the
// not-found tag this provider's read/delete paths depend on.
test.provider(
  "describeServer on a nonexistent server fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        transfer.describeServer({ ServerId: "s-00000000000000000" }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

const describeServer = (serverId: string) =>
  transfer.describeServer({ ServerId: serverId }).pipe(
    Effect.map((r) => r.Server),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );

const assertServerGone = (serverId: string) =>
  describeServer(serverId).pipe(
    Effect.flatMap((server) =>
      server === undefined
        ? Effect.void
        : Effect.fail(new Error(`server '${serverId}' still exists`)),
    ),
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(24),
      ]),
    }),
  );

// A running Transfer server is billed hourly. Provisioning to ONLINE takes a
// few minutes. The full lifecycle is gated behind AWS_TEST_SLOW=1 and always
// destroys what it created.
test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "create SFTP server + service-managed user, destroy, verify gone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { server, user } = yield* stack.deploy(
        Effect.gen(function* () {
          const server = yield* Server("Sftp", {
            protocols: ["SFTP"],
            domain: "S3",
            endpointType: "PUBLIC",
            identityProviderType: "SERVICE_MANAGED",
            tags: { env: "test" },
          });
          const role = yield* Role("TransferUserRole", {
            assumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "transfer.amazonaws.com" },
                  Action: ["sts:AssumeRole"],
                },
              ],
            },
            inlinePolicies: {
              s3: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Action: ["s3:ListBucket", "s3:GetObject", "s3:PutObject"],
                    Resource: ["*"],
                  },
                ],
              },
            },
          });
          const user = yield* User("Alice", {
            serverId: server.serverId,
            userName: "alice",
            role: role.roleArn,
            homeDirectory: "/example-bucket/alice",
            tags: { env: "test" },
          });
          return { server, user };
        }),
      );

      expect(server.arn).toContain(":server/");
      expect(server.protocols).toContain("SFTP");
      expect(server.domain).toBe("S3");
      expect(["ONLINE", "OFFLINE", "STARTING"]).toContain(server.state);
      expect(server.tags.env).toBe("test");

      // Out-of-band verification via distilled.
      const observedServer = yield* describeServer(server.serverId);
      expect(observedServer?.IdentityProviderType).toBe("SERVICE_MANAGED");

      expect(user.userName).toBe("alice");
      expect(user.arn).toContain(":user/");
      const observedUser = yield* transfer.describeUser({
        ServerId: server.serverId,
        UserName: "alice",
      });
      expect(observedUser.User.HomeDirectory).toBe("/example-bucket/alice");
      expect(observedUser.User.Role).toBe(user.role);

      yield* stack.destroy();
      yield* assertServerGone(server.serverId);
    }),
  { timeout: 900_000 },
);
