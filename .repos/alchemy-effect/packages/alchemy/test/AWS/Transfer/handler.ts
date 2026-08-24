import * as IAM from "@/AWS/IAM";
import * as Lambda from "@/AWS/Lambda";
import * as Transfer from "@/AWS/Transfer";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

/**
 * Fixture SSH public key — generated once with
 * `ssh-keygen -t ed25519` and checked in (public half only).
 */
export const TEST_SSH_PUBLIC_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDc7/2FDuRZgYQHMZujBoouOVFFp/WhqqbSSJ/+33hq2 alchemy-transfer-test";

const trustPolicy = {
  Version: "2012-10-17" as const,
  Statement: [
    {
      Effect: "Allow" as const,
      Principal: { Service: "transfer.amazonaws.com" },
      Action: ["sts:AssumeRole"],
    },
  ],
};

/**
 * Full (AWS_TEST_SLOW-gated) fixture: a real SFTP server + service-managed
 * user with every server/user-scoped Transfer binding attached.
 */
export class TransferTestFunction extends Lambda.Function<Lambda.Function>()(
  "TransferTestFunction",
) {}

export default TransferTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(60),
  },
  Effect.gen(function* () {
    const server = yield* Transfer.Server("BindingsServer", {
      protocols: ["SFTP"],
      domain: "S3",
      endpointType: "PUBLIC",
      identityProviderType: "SERVICE_MANAGED",
    });
    const role = yield* IAM.Role("BindingsUserRole", {
      assumeRolePolicyDocument: trustPolicy,
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
    const user = yield* Transfer.User("BindingsUser", {
      serverId: server.serverId,
      userName: "alice",
      role: role.roleArn,
      homeDirectory: "/example-bucket/alice",
    });

    const describeServer = yield* Transfer.DescribeServer(server);
    const startServer = yield* Transfer.StartServer(server);
    const stopServer = yield* Transfer.StopServer(server);
    const listUsers = yield* Transfer.ListUsers(server);
    const testIdentityProvider = yield* Transfer.TestIdentityProvider(server);
    const describeUser = yield* Transfer.DescribeUser(user);
    const importSshPublicKey = yield* Transfer.ImportSshPublicKey(user);
    const deleteSshPublicKey = yield* Transfer.DeleteSshPublicKey(user);

    const bound = {
      describeServer,
      startServer,
      stopServer,
      listUsers,
      testIdentityProvider,
      describeUser,
      importSshPublicKey,
      deleteSshPublicKey,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        // Server-scoped read: the ServerId is injected from the binding.
        if (request.method === "GET" && pathname === "/server") {
          const { Server } = yield* describeServer();
          return yield* HttpServerResponse.json({
            serverId: Server.ServerId,
            state: Server.State,
          });
        }

        if (request.method === "GET" && pathname === "/users") {
          const { Users } = yield* listUsers();
          return yield* HttpServerResponse.json({
            userNames: (Users ?? []).map((u) => u.UserName),
          });
        }

        // User-scoped read: ServerId + UserName injected from the binding.
        if (request.method === "GET" && pathname === "/user") {
          const { User } = yield* describeUser();
          return yield* HttpServerResponse.json({
            userName: User.UserName,
            keyIds: (User.SshPublicKeys ?? []).map((k) => k.SshPublicKeyId),
          });
        }

        // Key rotation: import the checked-in fixture key.
        if (request.method === "POST" && pathname === "/key") {
          const imported = yield* importSshPublicKey({
            SshPublicKeyBody: TEST_SSH_PUBLIC_KEY,
          }).pipe(Effect.result);
          return yield* HttpServerResponse.json(
            imported._tag === "Success"
              ? { ok: true, keyId: imported.success.SshPublicKeyId }
              : { ok: false, tag: imported.failure._tag },
          );
        }

        if (request.method === "DELETE" && pathname === "/key") {
          const keyId = url.searchParams.get("id");
          if (keyId === null) {
            return yield* HttpServerResponse.json(
              { error: "missing id" },
              { status: 400 },
            );
          }
          const deleted = yield* deleteSshPublicKey({
            SshPublicKeyId: keyId,
          }).pipe(Effect.result);
          return yield* HttpServerResponse.json(
            deleted._tag === "Success"
              ? { ok: true }
              : { ok: false, tag: deleted.failure._tag },
          );
        }

        // Availability control: valid only in ONLINE/OFFLINE respectively —
        // report the typed rejection so the test can assert the round-trip.
        if (request.method === "POST" && pathname === "/stop") {
          const stopped = yield* stopServer().pipe(Effect.result);
          return yield* HttpServerResponse.json(
            stopped._tag === "Success"
              ? { ok: true }
              : { ok: false, tag: stopped.failure._tag },
          );
        }

        if (request.method === "POST" && pathname === "/start") {
          const started = yield* startServer().pipe(Effect.result);
          return yield* HttpServerResponse.json(
            started._tag === "Success"
              ? { ok: true }
              : { ok: false, tag: started.failure._tag },
          );
        }

        // The fixture server is SERVICE_MANAGED, so Transfer rejects the
        // identity-provider test with the typed InvalidRequestException —
        // which still proves the binding + IAM round-trip.
        if (request.method === "POST" && pathname === "/test-idp") {
          const tested = yield* testIdentityProvider({
            UserName: "alice",
            UserPassword: Redacted.make("not-a-real-password"),
            ServerProtocol: "SFTP",
          }).pipe(Effect.result);
          return yield* HttpServerResponse.json(
            tested._tag === "Success"
              ? { ok: true, statusCode: tested.success.StatusCode }
              : { ok: false, tag: tested.failure._tag },
          );
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Transfer.DescribeServerHttp,
        Transfer.StartServerHttp,
        Transfer.StopServerHttp,
        Transfer.ListUsersHttp,
        Transfer.TestIdentityProviderHttp,
        Transfer.DescribeUserHttp,
        Transfer.ImportSshPublicKeyHttp,
        Transfer.DeleteSshPublicKeyHttp,
      ),
    ),
  ),
);
