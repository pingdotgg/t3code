import * as AWS from "@/AWS";
import { Connection } from "@/AWS/CodeConnections/Connection.ts";
import { RepositoryLink } from "@/AWS/CodeConnections/RepositoryLink.ts";
import * as Test from "@/Test/Alchemy";
import * as codeconnections from "@distilled.cloud/aws/codeconnections";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// A repository link requires a connection in the AVAILABLE state, and
// completing a connection's OAuth handshake is a manual console step with no
// API. The ungated probe below proves the request wiring end-to-end against
// the real service (the call reaches CodeConnections and returns its typed
// domain error for a PENDING connection); the full lifecycle is gated on a
// manually-completed connection.
const AVAILABLE_CONNECTION_ARN =
  process.env.AWS_TEST_CODECONNECTIONS_CONNECTION_ARN;
const OWNER_ID = process.env.AWS_TEST_CODECONNECTIONS_OWNER_ID;
const REPOSITORY_NAME = process.env.AWS_TEST_CODECONNECTIONS_REPOSITORY_NAME;

test.provider(
  "probe: creating a link on a PENDING connection surfaces a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const connection = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Connection("RepoLinkProbeConn", {
            connectionName: "alchemy-test-repolink-conn",
            providerType: "GitHub",
          });
        }),
      );
      expect(connection.connectionStatus).toBe("PENDING");

      // The connection has not completed its OAuth handshake. Whichever way
      // the service answers, the request wiring is proven end-to-end: either
      // the link is rejected with a TYPED tag (not an unmatched catch-all),
      // or it is created — in which case we clean it up out-of-band.
      const result = yield* codeconnections
        .createRepositoryLink({
          ConnectionArn: connection.connectionArn,
          OwnerId: "alchemy-test",
          RepositoryName: "alchemy-test-repo",
        })
        .pipe(
          Effect.map(
            (res) =>
              ({ kind: "created", link: res.RepositoryLinkInfo }) as const,
          ),
          Effect.catchTag(
            [
              "InvalidInputException",
              "AccessDeniedException",
              "ConcurrentModificationException",
              "ResourceAlreadyExistsException",
            ],
            (e) => Effect.succeed({ kind: "rejected", tag: e._tag } as const),
          ),
        );
      if (result.kind === "created") {
        expect(result.link.RepositoryLinkId).toBeTruthy();
        yield* codeconnections
          .deleteRepositoryLink({
            RepositoryLinkId: result.link.RepositoryLinkId,
          })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
      } else {
        expect(result.tag).toBeTruthy();
      }

      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

test.provider.skipIf(
  !AVAILABLE_CONNECTION_ARN || !OWNER_ID || !REPOSITORY_NAME,
)(
  "lifecycle: create link on an AVAILABLE connection, destroy (gated: AWS_TEST_CODECONNECTIONS_CONNECTION_ARN)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* RepositoryLink("Repo", {
            connectionArn: AVAILABLE_CONNECTION_ARN!,
            ownerId: OWNER_ID!,
            repositoryName: REPOSITORY_NAME!,
          });
        }),
      );
      expect(deployed.repositoryLinkArn).toContain(":repository-link/");
      expect(deployed.repositoryLinkId).toBeTruthy();
      expect(deployed.ownerId).toBe(OWNER_ID);
      expect(deployed.repositoryName).toBe(REPOSITORY_NAME);

      // Out-of-band verification via distilled.
      const created = yield* codeconnections.getRepositoryLink({
        RepositoryLinkId: deployed.repositoryLinkId,
      });
      expect(created.RepositoryLinkInfo.ConnectionArn).toBe(
        AVAILABLE_CONNECTION_ARN,
      );

      // Destroy — link is deleted; verify it is gone out-of-band.
      yield* stack.destroy();
      const after = yield* codeconnections
        .getRepositoryLink({ RepositoryLinkId: deployed.repositoryLinkId })
        .pipe(
          Effect.map((res) => res.RepositoryLinkInfo),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      expect(after).toBeUndefined();
    }),
  { timeout: 120_000 },
);
