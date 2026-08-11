// @effect-diagnostics nodeBuiltinImport:off - these tests inspect disposable physical SQLite boundaries directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { afterEach, assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { getCanonicalWorkspaceResolver } from "./canonicalWorkspaceAccess.ts";
import {
  MarketingArtifactId,
  MarketingIdempotencyKey,
  MarketingOrganizationId,
  MarketingProjectId,
  MarketingT3ReferenceBindingId,
  MarketingWorkspaceId,
  T3ActorIssuer,
  T3ActorSubject,
  type MarketingActorId,
  type MarketingWorkspaceSelection,
} from "./identity.ts";
import { MarketingActorResolutionError } from "./errors.ts";
import {
  makeOrganizationWorkspaceStore,
  organizationWorkspaceDatabasePath,
  type MarketingAuthorizedActorIdentity,
  type MarketingWorkspaceAuthorizationRequirement,
  type MarketingWorkspacePermission,
  type OrganizationWorkspaceStoreError,
} from "./workspaceStore.ts";

const testRoots: string[] = [];
const now = DateTime.makeUnsafe("2030-01-01T00:00:00.000Z");

afterEach(() => {
  for (const root of testRoots.splice(0)) {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "auldric-marketing-domain-"));
  testRoots.push(root);
  return root;
}

function uuid(suffix: number): string {
  return `123e4567-e89b-42d3-a456-${String(suffix).padStart(12, "0")}`;
}

function selection(seed: number): MarketingWorkspaceSelection {
  return {
    organizationId: MarketingOrganizationId.make(`morg_${uuid(seed)}`),
    projectId: MarketingProjectId.make(`mprj_${uuid(seed)}`),
    workspaceId: MarketingWorkspaceId.make(`mwsp_${uuid(seed)}`),
  };
}

const allPermissions: ReadonlySet<MarketingWorkspacePermission> = new Set([
  "bootstrap-new-organization",
  "join-existing-organization",
  "resolve-workspace",
  "revoke-membership",
  "delete-workspace",
  "link-t3-reference",
  "mark-t3-reference-stale",
  "delete-t3-reference",
  "backfill-workspace",
  "rollback-provisioning",
]);

declare const TestRequestAuthorityTypeId: unique symbol;
interface TestRequestAuthority {
  readonly [TestRequestAuthorityTypeId]: true;
}

interface AuthorityGrant {
  readonly actor: MarketingAuthorizedActorIdentity;
  readonly permissions: ReadonlySet<MarketingWorkspacePermission>;
  readonly organizationId?: MarketingOrganizationId;
}

const authorityGrants = new WeakMap<object, AuthorityGrant>();

function requestAuthority(
  seed: number,
  permissions: ReadonlySet<MarketingWorkspacePermission> = allPermissions,
  organizationId?: MarketingOrganizationId,
): TestRequestAuthority {
  const authority = {} as TestRequestAuthority;
  authorityGrants.set(authority, {
    actor: {
      issuer: T3ActorIssuer.make("https://identity.t3.codes"),
      subject: T3ActorSubject.make(`user_${seed}`),
    },
    permissions,
    ...(organizationId === undefined ? {} : { organizationId }),
  });
  return authority;
}

function makeStore(root: string, observed: Array<MarketingWorkspaceAuthorizationRequirement> = []) {
  return makeOrganizationWorkspaceStore<TestRequestAuthority>({
    stateRoot: root,
    authorize: (authority, requirement) => {
      observed.push(requirement);
      const grant = authorityGrants.get(authority);
      if (
        grant === undefined ||
        !grant.permissions.has(requirement.permission) ||
        (grant.organizationId !== undefined &&
          grant.organizationId !== requirement.selection.organizationId)
      ) {
        return Effect.fail(
          new MarketingActorResolutionError({ reason: "request_authority_rejected" }),
        );
      }
      return Effect.succeed(grant.actor);
    },
  });
}

function databaseResolver(store: ReturnType<typeof makeStore>) {
  return getCanonicalWorkspaceResolver<TestRequestAuthority, OrganizationWorkspaceStoreError>(
    store,
  );
}

function bootstrapInput(seed: number, authority = requestAuthority(seed)) {
  return {
    requestAuthority: authority,
    selection: selection(seed),
    idempotencyKey: MarketingIdempotencyKey.make(`bootstrap-${seed}`),
  };
}

function createOrganizationSchemaV1(
  root: string,
  workspaceSelection: MarketingWorkspaceSelection,
  versions: ReadonlyArray<number> = [1],
): string {
  const databasePath = organizationWorkspaceDatabasePath(root, workspaceSelection.organizationId);
  const databaseKey = NodePath.basename(NodePath.dirname(databasePath));
  NodeFS.mkdirSync(NodePath.dirname(databasePath), { recursive: true });
  const database = new NodeSqlite.DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE auldric_organization_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE auldric_organization_identity (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      organization_id TEXT NOT NULL,
      database_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE auldric_marketing_workspace_registry (
      workspace_id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  database
    .prepare(
      `INSERT INTO auldric_organization_identity(
         singleton, organization_id, database_key, created_at
       ) VALUES (1, ?, ?, 'existing')`,
    )
    .run(workspaceSelection.organizationId, databaseKey);
  database
    .prepare(
      `INSERT INTO auldric_marketing_workspace_registry(
         workspace_id, organization_id, project_id, created_at
       ) VALUES (?, ?, ?, 'existing')`,
    )
    .run(
      workspaceSelection.workspaceId,
      workspaceSelection.organizationId,
      workspaceSelection.projectId,
    );
  for (const version of versions) {
    database
      .prepare(
        `INSERT INTO auldric_organization_schema_migrations(version, applied_at)
         VALUES (?, 'existing')`,
      )
      .run(version);
  }
  database.close();
  return databasePath;
}

describe("organization Marketing workspace store", () => {
  it.effect("bootstraps one new physical organization database and resolves it idempotently", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now.epochMilliseconds);
      const root = makeRoot();
      const store = makeStore(root);
      const input = bootstrapInput(1);

      const first = yield* store.bootstrap(input);
      const second = yield* store.bootstrap(input);
      assert.deepEqual(second, first);

      const resolvedPath = yield* databaseResolver(store)(
        { requestAuthority: input.requestAuthority, selection: input.selection },
        ({ database, databasePath }) =>
          Effect.sync(() => {
            const migrations = database
              .prepare("SELECT COUNT(*) AS count FROM auldric_organization_schema_migrations")
              .get() as unknown as { readonly count: number };
            assert.equal(migrations.count, 3);
            return databasePath;
          }),
      );

      assert.equal(
        resolvedPath,
        organizationWorkspaceDatabasePath(root, input.selection.organizationId),
      );
      assert.isTrue(NodeFS.existsSync(resolvedPath));
      assert.isTrue(NodeFS.existsSync(NodePath.join(root, "control.sqlite")));
      assert.match(first.marketingActorId, /^mact_[0-9a-f-]{36}$/u);
      const publicResolution = yield* store.resolve(
        { requestAuthority: input.requestAuthority, selection: input.selection },
        (workspace) => Effect.succeed(workspace),
      );
      assert.notProperty(publicResolution, "database");
      assert.notProperty(publicResolution, "databasePath");
      assert.deepEqual(Object.getOwnPropertySymbols(store), []);
    }),
  );

  it.effect(
    "rejects wire-shaped authority clones and prevents self-enrollment into an existing organization",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(now.epochMilliseconds);
        const root = makeRoot();
        const store = makeStore(root);
        const owner = bootstrapInput(2);
        yield* store.bootstrap(owner);

        const wireClone = { ...owner.requestAuthority } as TestRequestAuthority;
        const cloneError = yield* store
          .resolve({ requestAuthority: wireClone, selection: owner.selection }, () => Effect.void)
          .pipe(Effect.flip);
        assert.equal(cloneError._tag, "MarketingActorResolutionError");
        if (cloneError._tag === "MarketingActorResolutionError") {
          assert.equal(cloneError.reason, "request_authority_rejected");
        }

        const outsiderAuthority = requestAuthority(
          3,
          new Set<MarketingWorkspacePermission>(["bootstrap-new-organization"]),
        );
        const selfEnrollment = yield* store
          .bootstrap({
            requestAuthority: outsiderAuthority,
            selection: owner.selection,
            idempotencyKey: MarketingIdempotencyKey.make("outsider-bootstrap"),
          })
          .pipe(Effect.flip);
        assert.equal(selfEnrollment._tag, "MarketingWorkspaceConflictError");
        if (selfEnrollment._tag === "MarketingWorkspaceConflictError") {
          assert.equal(selfEnrollment.reason, "organization_already_exists");
        }

        const unauthorizedJoin = yield* store
          .join({ requestAuthority: outsiderAuthority, selection: owner.selection })
          .pipe(Effect.flip);
        assert.equal(unauthorizedJoin._tag, "MarketingActorResolutionError");

        const invitedAuthority = requestAuthority(
          3,
          new Set<MarketingWorkspacePermission>(["join-existing-organization"]),
          owner.selection.organizationId,
        );
        const joined = yield* store.join({
          requestAuthority: invitedAuthority,
          selection: owner.selection,
        });
        assert.notEqual(joined.marketingActorId, (yield* store.bootstrap(owner)).marketingActorId);

        const memberAuthority = requestAuthority(
          3,
          new Set<MarketingWorkspacePermission>(["resolve-workspace"]),
          owner.selection.organizationId,
        );
        assert.equal(
          yield* store.resolve(
            { requestAuthority: memberAuthority, selection: owner.selection },
            ({ marketingActorId }) => Effect.succeed(marketingActorId),
          ),
          joined.marketingActorId,
        );

        const control = new NodeSqlite.DatabaseSync(NodePath.join(root, "control.sqlite"), {
          readOnly: true,
        });
        const counts = control
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM marketing_actors) AS actors,
               (SELECT COUNT(*) FROM marketing_organization_memberships) AS memberships`,
          )
          .get() as unknown as { readonly actors: number; readonly memberships: number };
        control.close();
        assert.deepEqual(counts, { actors: 2, memberships: 2 });
      }),
  );

  it.effect("fails closed for cross-organization selections and copied databases", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now.epochMilliseconds);
      const root = makeRoot();
      const store = makeStore(root);
      const first = bootstrapInput(4);
      const second = bootstrapInput(5);
      yield* store.bootstrap(first);
      yield* store.bootstrap(second);

      const mixedSelection = { ...first.selection, workspaceId: second.selection.workspaceId };
      const mixed = yield* store
        .resolve(
          { requestAuthority: first.requestAuthority, selection: mixedSelection },
          () => Effect.void,
        )
        .pipe(Effect.flip);
      assert.equal(mixed._tag, "MarketingWorkspaceCrossOrganizationError");

      const firstPath = organizationWorkspaceDatabasePath(root, first.selection.organizationId);
      const secondPath = organizationWorkspaceDatabasePath(root, second.selection.organizationId);
      NodeFS.copyFileSync(secondPath, firstPath);
      const copied = yield* store
        .resolve(
          { requestAuthority: first.requestAuthority, selection: first.selection },
          () => Effect.void,
        )
        .pipe(Effect.flip);
      assert.equal(copied._tag, "MarketingWorkspaceUnavailableError");
      if (copied._tag === "MarketingWorkspaceUnavailableError") {
        assert.equal(copied.reason, "workspace_database_identity_mismatch");
      }
    }),
  );

  it.effect("does not recreate a missing workspace database on idempotent replay", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now.epochMilliseconds);
      const root = makeRoot();
      const store = makeStore(root);
      const input = bootstrapInput(6);
      yield* store.bootstrap(input);
      const workspacePath = organizationWorkspaceDatabasePath(root, input.selection.organizationId);
      NodeFS.unlinkSync(workspacePath);

      const missing = yield* store
        .resolve(
          { requestAuthority: input.requestAuthority, selection: input.selection },
          () => Effect.void,
        )
        .pipe(Effect.flip);
      assert.equal(missing._tag, "MarketingWorkspaceUnavailableError");

      const replay = yield* store.bootstrap(input).pipe(Effect.flip);
      assert.equal(replay._tag, "MarketingWorkspaceUnavailableError");
      assert.isFalse(NodeFS.existsSync(workspacePath));
    }),
  );

  it("hashes even invalid caller input before constructing a tenant path", () => {
    const root = makeRoot();
    const malicious = "../../outside" as MarketingOrganizationId;
    const resolved = organizationWorkspaceDatabasePath(root, malicious);

    assert.isTrue(resolved.startsWith(`${NodePath.resolve(root)}${NodePath.sep}`));
    assert.notInclude(NodePath.relative(root, resolved), "..");
    assert.notInclude(resolved, "outside");
  });

  it.effect("binds an idempotency key to one actor, origin, and workspace operation", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now.epochMilliseconds);
      const store = makeStore(makeRoot());
      const first = bootstrapInput(7);
      yield* store.bootstrap(first);
      const conflicting = bootstrapInput(8, first.requestAuthority);

      const error = yield* store
        .bootstrap({ ...conflicting, idempotencyKey: first.idempotencyKey })
        .pipe(Effect.flip);
      assert.equal(error._tag, "MarketingWorkspaceConflictError");
      if (error._tag === "MarketingWorkspaceConflictError") {
        assert.equal(error.reason, "idempotency_key_reused");
      }
    }),
  );

  it.effect("requires scoped authority to revoke a membership", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now.epochMilliseconds);
      const store = makeStore(makeRoot());
      const owner = bootstrapInput(9);
      yield* store.bootstrap(owner);
      const invitation = requestAuthority(
        10,
        new Set<MarketingWorkspacePermission>(["join-existing-organization"]),
        owner.selection.organizationId,
      );
      const member = yield* store.join({
        requestAuthority: invitation,
        selection: owner.selection,
      });

      const unprivileged = requestAuthority(
        9,
        new Set<MarketingWorkspacePermission>(["resolve-workspace"]),
        owner.selection.organizationId,
      );
      const denied = yield* store
        .revokeMembership({
          requestAuthority: unprivileged,
          selection: owner.selection,
          targetMarketingActorId: member.marketingActorId,
        })
        .pipe(Effect.flip);
      assert.equal(denied._tag, "MarketingActorResolutionError");

      assert.isTrue(
        yield* store.revokeMembership({
          requestAuthority: owner.requestAuthority,
          selection: owner.selection,
          targetMarketingActorId: member.marketingActorId,
        }),
      );
      assert.isFalse(
        yield* store.revokeMembership({
          requestAuthority: owner.requestAuthority,
          selection: owner.selection,
          targetMarketingActorId: member.marketingActorId,
        }),
      );

      const memberRequest = requestAuthority(
        10,
        new Set<MarketingWorkspacePermission>(["resolve-workspace"]),
        owner.selection.organizationId,
      );
      const revoked = yield* store
        .resolve({ requestAuthority: memberRequest, selection: owner.selection }, () => Effect.void)
        .pipe(Effect.flip);
      assert.equal(revoked._tag, "MarketingActorResolutionError");
      if (revoked._tag === "MarketingActorResolutionError") {
        assert.equal(revoked.reason, "membership_revoked");
      }
    }),
  );

  it.effect("fails a completed bootstrap replay after the owner's membership is revoked", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now.epochMilliseconds);
      const store = makeStore(makeRoot());
      const owner = bootstrapInput(91);
      const binding = yield* store.bootstrap(owner);

      assert.isTrue(
        yield* store.revokeMembership({
          requestAuthority: owner.requestAuthority,
          selection: owner.selection,
          targetMarketingActorId: binding.marketingActorId,
        }),
      );

      const replay = yield* store.bootstrap(owner).pipe(Effect.flip);
      assert.equal(replay._tag, "MarketingActorResolutionError");
      if (replay._tag === "MarketingActorResolutionError") {
        assert.equal(replay.reason, "membership_revoked");
      }
    }),
  );

  it.effect(
    "drains active handles, survives deletion cancellation, and lets a retry finish without unlinking early",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(now.epochMilliseconds);
          const root = makeRoot();
          const store = makeStore(root);
          const owner = bootstrapInput(11);
          yield* store.bootstrap(owner);
          const handleStarted = yield* Deferred.make<void>();
          const releaseHandle = yield* Deferred.make<void>();
          const handleFinished = yield* Deferred.make<void>();

          const resolveFiber = yield* Effect.forkChild(
            databaseResolver(store)(
              { requestAuthority: owner.requestAuthority, selection: owner.selection },
              ({ database }) =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(handleStarted, undefined);
                  yield* Deferred.await(releaseHandle);
                  database.exec("CREATE TABLE lease_probe(value TEXT NOT NULL);");
                  yield* Deferred.succeed(handleFinished, undefined);
                }),
            ),
          );
          yield* Deferred.await(handleStarted);

          const firstDeletion = yield* Effect.forkChild(
            store.deleteOrganizationWorkspace({
              requestAuthority: owner.requestAuthority,
              selection: owner.selection,
            }),
          );
          yield* Effect.yieldNow;

          const control = new NodeSqlite.DatabaseSync(NodePath.join(root, "control.sqlite"), {
            readOnly: true,
          });
          const deletionState = control
            .prepare("SELECT state FROM marketing_workspaces WHERE id = ?")
            .get(owner.selection.workspaceId) as unknown as { readonly state: string };
          control.close();
          assert.equal(deletionState.state, "deleting");
          assert.isTrue(Option.isNone(yield* Deferred.poll(handleFinished)));

          yield* Fiber.interrupt(firstDeletion);
          const retryFinished = yield* Deferred.make<boolean>();
          const retry = yield* Effect.forkChild(
            store
              .deleteOrganizationWorkspace({
                requestAuthority: owner.requestAuthority,
                selection: owner.selection,
              })
              .pipe(Effect.tap((deleted) => Deferred.succeed(retryFinished, deleted))),
          );
          yield* Effect.yieldNow;
          assert.isTrue(Option.isNone(yield* Deferred.poll(retryFinished)));

          const newResolve = yield* store
            .resolve(
              { requestAuthority: owner.requestAuthority, selection: owner.selection },
              () => Effect.void,
            )
            .pipe(Effect.flip);
          assert.equal(newResolve._tag, "MarketingWorkspaceUnavailableError");

          yield* Deferred.succeed(releaseHandle, undefined);
          yield* Deferred.await(handleFinished);
          yield* Fiber.join(resolveFiber);
          assert.isTrue(yield* Deferred.await(retryFinished));
          assert.isTrue(yield* Fiber.join(retry));
          assert.isFalse(
            NodeFS.existsSync(
              organizationWorkspaceDatabasePath(root, owner.selection.organizationId),
            ),
          );
        }),
      ),
  );

  it.effect(
    "shares an active-handle deletion drain across store factories for one resolved state root",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(now.epochMilliseconds);
          const root = makeRoot();
          const storeA = makeStore(root);
          const storeB = makeStore(`${root}${NodePath.sep}factory-alias${NodePath.sep}..`);
          const owner = bootstrapInput(116);
          yield* storeA.bootstrap(owner);
          const databasePath = organizationWorkspaceDatabasePath(
            root,
            owner.selection.organizationId,
          );
          const openHandle = yield* Deferred.make<NodeSqlite.DatabaseSync>();
          const releaseHandle = yield* Deferred.make<void>();
          const deletionFinished = yield* Deferred.make<boolean>();

          const resolveFiber = yield* Effect.forkChild(
            databaseResolver(storeA)(
              { requestAuthority: owner.requestAuthority, selection: owner.selection },
              ({ database }) =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(openHandle, database);
                  yield* Deferred.await(releaseHandle);
                  database.exec("CREATE TABLE shared_factory_lease_probe(value TEXT NOT NULL);");
                }),
            ),
          );
          const database = yield* Deferred.await(openHandle);
          assert.isTrue(database.isOpen);

          const deletionFiber = yield* Effect.forkChild(
            storeB
              .deleteOrganizationWorkspace({
                requestAuthority: owner.requestAuthority,
                selection: owner.selection,
              })
              .pipe(Effect.tap((deleted) => Deferred.succeed(deletionFinished, deleted))),
          );
          yield* Effect.yieldNow;

          const control = new NodeSqlite.DatabaseSync(NodePath.join(root, "control.sqlite"), {
            readOnly: true,
          });
          const deletionState = control
            .prepare("SELECT state FROM marketing_workspaces WHERE id = ?")
            .get(owner.selection.workspaceId) as unknown as { readonly state: string };
          control.close();
          assert.equal(deletionState.state, "deleting");
          assert.isTrue(NodeFS.existsSync(databasePath));
          assert.isTrue(Option.isNone(yield* Deferred.poll(deletionFinished)));
          assert.isTrue(database.isOpen);

          yield* Deferred.succeed(releaseHandle, undefined);
          yield* Fiber.join(resolveFiber);
          assert.isFalse(database.isOpen);
          assert.isTrue(yield* Deferred.await(deletionFinished));
          assert.isTrue(yield* Fiber.join(deletionFiber));
          assert.isFalse(NodeFS.existsSync(databasePath));
        }),
      ),
  );

  it.effect("aborts a failed pre-transition deletion gate without wedging active resolution", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now.epochMilliseconds);
      const store = makeStore(makeRoot());
      const first = bootstrapInput(111);
      const second = bootstrapInput(112);
      yield* store.bootstrap(first);
      yield* store.bootstrap(second);

      const invalidSelection = {
        ...first.selection,
        workspaceId: second.selection.workspaceId,
      };
      const deletion = yield* store
        .deleteOrganizationWorkspace({
          requestAuthority: first.requestAuthority,
          selection: invalidSelection,
        })
        .pipe(Effect.flip);
      assert.equal(deletion._tag, "MarketingWorkspaceCrossOrganizationError");

      assert.equal(
        yield* store.resolve(
          { requestAuthority: first.requestAuthority, selection: first.selection },
          ({ selection: resolved }) => Effect.succeed(resolved.organizationId),
        ),
        first.selection.organizationId,
      );
    }),
  );

  it.effect(
    "drains a provisioning-state lease and resumes rollback after cancellation without unlinking early",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(now.epochMilliseconds);
          const root = makeRoot();
          const store = makeStore(root);
          const owner = bootstrapInput(113);
          yield* store.bootstrap(owner);
          const databasePath = organizationWorkspaceDatabasePath(
            root,
            owner.selection.organizationId,
          );
          const handleStarted = yield* Deferred.make<void>();
          const releaseHandle = yield* Deferred.make<void>();
          const handleFinished = yield* Deferred.make<void>();

          const resolveFiber = yield* Effect.forkChild(
            databaseResolver(store)(
              { requestAuthority: owner.requestAuthority, selection: owner.selection },
              ({ database }) =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(handleStarted, undefined);
                  yield* Deferred.await(releaseHandle);
                  database.exec("CREATE TABLE rollback_lease_probe(value TEXT NOT NULL);");
                  yield* Deferred.succeed(handleFinished, undefined);
                }),
            ),
          );
          yield* Deferred.await(handleStarted);

          const control = new NodeSqlite.DatabaseSync(NodePath.join(root, "control.sqlite"));
          control.exec("BEGIN IMMEDIATE;");
          control
            .prepare("UPDATE marketing_workspaces SET state = 'provisioning' WHERE id = ?")
            .run(owner.selection.workspaceId);
          control
            .prepare(
              `UPDATE marketing_identity_operations SET state = 'pending'
               WHERE idempotency_key = ?`,
            )
            .run(owner.idempotencyKey);
          control.exec("COMMIT;");
          control.close();

          const firstRollback = yield* Effect.forkChild(
            store.rollbackProvisioning({
              requestAuthority: owner.requestAuthority,
              selection: owner.selection,
            }),
          );
          yield* Effect.yieldNow;

          const markedControl = new NodeSqlite.DatabaseSync(NodePath.join(root, "control.sqlite"), {
            readOnly: true,
          });
          const marked = markedControl
            .prepare(
              `SELECT w.state AS workspaceState, o.state AS organizationState
               FROM marketing_workspaces w
               JOIN marketing_organizations o ON o.id = w.organization_id
               WHERE w.id = ?`,
            )
            .get(owner.selection.workspaceId) as unknown as {
            readonly workspaceState: string;
            readonly organizationState: string;
          };
          markedControl.close();
          assert.deepEqual(marked, {
            workspaceState: "rolled_back",
            organizationState: "deleting",
          });
          assert.isTrue(NodeFS.existsSync(databasePath));
          assert.isTrue(Option.isNone(yield* Deferred.poll(handleFinished)));

          yield* Fiber.interrupt(firstRollback);
          const retryFinished = yield* Deferred.make<boolean>();
          const retry = yield* Effect.forkChild(
            store
              .rollbackProvisioning({
                requestAuthority: owner.requestAuthority,
                selection: owner.selection,
              })
              .pipe(Effect.tap((rolledBack) => Deferred.succeed(retryFinished, rolledBack))),
          );
          yield* Effect.yieldNow;
          assert.isTrue(Option.isNone(yield* Deferred.poll(retryFinished)));
          assert.isTrue(NodeFS.existsSync(databasePath));

          yield* Deferred.succeed(releaseHandle, undefined);
          yield* Deferred.await(handleFinished);
          yield* Fiber.join(resolveFiber);
          assert.isTrue(yield* Deferred.await(retryFinished));
          assert.isTrue(yield* Fiber.join(retry));
          assert.isFalse(NodeFS.existsSync(databasePath));
        }),
      ),
  );

  it.effect(
    "atomically tombstones a failed provision and leaves every identity path fail closed",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(now.epochMilliseconds);
        const root = makeRoot();
        const owner = bootstrapInput(114);
        const databasePath = organizationWorkspaceDatabasePath(
          root,
          owner.selection.organizationId,
        );
        NodeFS.mkdirSync(NodePath.dirname(databasePath), { recursive: true });
        const crashDatabase = new NodeSqlite.DatabaseSync(databasePath);
        crashDatabase.exec(`
          CREATE TABLE auldric_organization_schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL
          );
          INSERT INTO auldric_organization_schema_migrations(version, applied_at)
          VALUES (1, 'interrupted');
        `);
        crashDatabase.close();

        const store = makeStore(root);
        const provisionFailure = yield* store.bootstrap(owner).pipe(Effect.flip);
        assert.equal(provisionFailure._tag, "MarketingWorkspaceUnavailableError");
        assert.isTrue(NodeFS.existsSync(databasePath));

        const bindingId = MarketingT3ReferenceBindingId.make(`mt3r_${uuid(114)}`);
        const control = new NodeSqlite.DatabaseSync(NodePath.join(root, "control.sqlite"));
        control
          .prepare(
            `INSERT INTO marketing_t3_reference_bindings(
               id, organization_id, target_kind, target_id,
               reference_kind, reference_value, state, linked_at, expires_at
             ) VALUES (?, ?, 'artifact', ?, 'thread', ?, 'active', ?, ?)`,
          )
          .run(
            bindingId,
            owner.selection.organizationId,
            MarketingArtifactId.make(`mart_${uuid(114)}`),
            "thread-sensitive-rollback",
            DateTime.formatIso(now),
            "2030-01-02T00:00:00.000Z",
          );
        control.close();

        assert.isTrue(
          yield* store.rollbackProvisioning({
            requestAuthority: owner.requestAuthority,
            selection: owner.selection,
          }),
        );
        assert.isFalse(
          yield* store.rollbackProvisioning({
            requestAuthority: owner.requestAuthority,
            selection: owner.selection,
          }),
        );
        assert.isFalse(NodeFS.existsSync(databasePath));

        const tombstones = new NodeSqlite.DatabaseSync(NodePath.join(root, "control.sqlite"), {
          readOnly: true,
        });
        const lifecycle = tombstones
          .prepare(
            `SELECT
               (SELECT state FROM marketing_organizations WHERE id = ?) AS organizationState,
               (SELECT deleted_at FROM marketing_organizations WHERE id = ?) AS organizationDeletedAt,
               (SELECT state FROM marketing_projects WHERE id = ?) AS projectState,
               (SELECT deleted_at FROM marketing_projects WHERE id = ?) AS projectDeletedAt,
               (SELECT state FROM marketing_workspaces WHERE id = ?) AS workspaceState,
               (SELECT deleted_at FROM marketing_workspaces WHERE id = ?) AS workspaceDeletedAt,
               (SELECT state FROM marketing_identity_operations WHERE idempotency_key = ?)
                 AS operationState`,
          )
          .get(
            owner.selection.organizationId,
            owner.selection.organizationId,
            owner.selection.projectId,
            owner.selection.projectId,
            owner.selection.workspaceId,
            owner.selection.workspaceId,
            owner.idempotencyKey,
          ) as unknown as {
          readonly organizationState: string;
          readonly organizationDeletedAt: string | null;
          readonly projectState: string;
          readonly projectDeletedAt: string | null;
          readonly workspaceState: string;
          readonly workspaceDeletedAt: string | null;
          readonly operationState: string;
        };
        const membership = tombstones
          .prepare(
            `SELECT status, revoked_at AS revokedAt
             FROM marketing_organization_memberships WHERE organization_id = ?`,
          )
          .get(owner.selection.organizationId) as unknown as {
          readonly status: string;
          readonly revokedAt: string | null;
        };
        const reference = tombstones
          .prepare(
            `SELECT state, reference_kind AS referenceKind,
                    reference_value AS referenceValue, expires_at AS expiresAt,
                    deleted_at AS deletedAt
             FROM marketing_t3_reference_bindings WHERE id = ?`,
          )
          .get(bindingId) as unknown as {
          readonly state: string;
          readonly referenceKind: string | null;
          readonly referenceValue: string | null;
          readonly expiresAt: string | null;
          readonly deletedAt: string | null;
        };
        tombstones.close();

        assert.equal(lifecycle.organizationState, "deleted");
        assert.isNotNull(lifecycle.organizationDeletedAt);
        assert.equal(lifecycle.projectState, "deleted");
        assert.isNotNull(lifecycle.projectDeletedAt);
        assert.equal(lifecycle.workspaceState, "rolled_back");
        assert.isNotNull(lifecycle.workspaceDeletedAt);
        assert.equal(lifecycle.operationState, "failed");
        assert.equal(membership.status, "revoked");
        assert.isNotNull(membership.revokedAt);
        assert.deepEqual(reference, {
          state: "deleted",
          referenceKind: null,
          referenceValue: null,
          expiresAt: null,
          deletedAt: DateTime.formatIso(now),
        });

        const replay = yield* store.bootstrap(owner).pipe(Effect.flip);
        assert.equal(replay._tag, "MarketingWorkspaceConflictError");
        if (replay._tag === "MarketingWorkspaceConflictError") {
          assert.equal(replay.reason, "organization_not_active");
        }
        const join = yield* store
          .join({
            requestAuthority: requestAuthority(
              115,
              new Set<MarketingWorkspacePermission>(["join-existing-organization"]),
              owner.selection.organizationId,
            ),
            selection: owner.selection,
          })
          .pipe(Effect.flip);
        assert.equal(join._tag, "MarketingWorkspaceUnavailableError");
        if (join._tag === "MarketingWorkspaceUnavailableError") {
          assert.equal(join.reason, "organization_unavailable");
        }
        const resolve = yield* store
          .resolve(
            { requestAuthority: owner.requestAuthority, selection: owner.selection },
            () => Effect.void,
          )
          .pipe(Effect.flip);
        assert.equal(resolve._tag, "MarketingActorResolutionError");
        if (resolve._tag === "MarketingActorResolutionError") {
          assert.equal(resolve.reason, "membership_revoked");
        }
      }),
  );

  it.effect(
    "deletion revokes every membership, erases T3 values, and retains non-sensitive lifecycle records",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(now.epochMilliseconds);
        const root = makeRoot();
        const store = makeStore(root);
        const owner = bootstrapInput(12);
        const ownerBinding = yield* store.bootstrap(owner);
        const invited = requestAuthority(
          13,
          new Set<MarketingWorkspacePermission>(["join-existing-organization"]),
          owner.selection.organizationId,
        );
        yield* store.join({ requestAuthority: invited, selection: owner.selection });

        const bindingId = MarketingT3ReferenceBindingId.make(`mt3r_${uuid(12)}`);
        yield* store.linkT3Reference({
          requestAuthority: owner.requestAuthority,
          selection: owner.selection,
          bindingId,
          target: {
            kind: "artifact",
            id: MarketingArtifactId.make(`mart_${uuid(12)}`),
          },
          reference: { kind: "thread", value: ThreadId.make("thread-sensitive") },
          expiresAt: DateTime.makeUnsafe("2030-01-02T00:00:00.000Z"),
        });

        assert.isTrue(
          yield* store.deleteOrganizationWorkspace({
            requestAuthority: owner.requestAuthority,
            selection: owner.selection,
          }),
        );
        assert.isFalse(
          yield* store.deleteOrganizationWorkspace({
            requestAuthority: owner.requestAuthority,
            selection: owner.selection,
          }),
        );

        const control = new NodeSqlite.DatabaseSync(NodePath.join(root, "control.sqlite"), {
          readOnly: true,
        });
        const membership = control
          .prepare(
            `SELECT COUNT(*) AS total,
                    SUM(CASE WHEN status = 'revoked' THEN 1 ELSE 0 END) AS revoked
             FROM marketing_organization_memberships WHERE organization_id = ?`,
          )
          .get(owner.selection.organizationId) as unknown as {
          readonly total: number;
          readonly revoked: number;
        };
        const reference = control
          .prepare(
            `SELECT state, reference_kind AS referenceKind,
                    reference_value AS referenceValue, expires_at AS expiresAt
             FROM marketing_t3_reference_bindings WHERE id = ?`,
          )
          .get(bindingId) as unknown as {
          readonly state: string;
          readonly referenceKind: string | null;
          readonly referenceValue: string | null;
          readonly expiresAt: string | null;
        };
        const operation = control
          .prepare(
            `SELECT state, organization_id AS organizationId, workspace_id AS workspaceId
             FROM marketing_identity_operations WHERE idempotency_key = ?`,
          )
          .get(owner.idempotencyKey) as unknown as {
          readonly state: string;
          readonly organizationId: string;
          readonly workspaceId: string;
        };
        control.close();

        assert.deepEqual(membership, { total: 2, revoked: 2 });
        assert.deepEqual(reference, {
          state: "deleted",
          referenceKind: null,
          referenceValue: null,
          expiresAt: null,
        });
        assert.deepEqual(operation, {
          state: "completed",
          organizationId: owner.selection.organizationId,
          workspaceId: owner.selection.workspaceId,
        });

        const resolveAfterDeletion = yield* store
          .resolve(
            { requestAuthority: owner.requestAuthority, selection: owner.selection },
            () => Effect.void,
          )
          .pipe(Effect.flip);
        assert.equal(resolveAfterDeletion._tag, "MarketingActorResolutionError");

        const rebootstrap = yield* store.bootstrap(owner).pipe(Effect.flip);
        assert.equal(rebootstrap._tag, "MarketingWorkspaceConflictError");
        const postDeletionJoin = yield* store
          .join({
            requestAuthority: requestAuthority(
              14,
              new Set<MarketingWorkspacePermission>(["join-existing-organization"]),
              owner.selection.organizationId,
            ),
            selection: owner.selection,
          })
          .pipe(Effect.flip);
        assert.equal(postDeletionJoin._tag, "MarketingWorkspaceUnavailableError");
        if (postDeletionJoin._tag === "MarketingWorkspaceUnavailableError") {
          assert.equal(postDeletionJoin.reason, "organization_unavailable");
        }
        assert.equal(ownerBinding.marketingActorId.length, 41);
      }),
  );

  it.effect("treats an empty organization database as v0 and repeats exact v3 safely", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now.epochMilliseconds);
      const root = makeRoot();
      const store = makeStore(root);
      const input = bootstrapInput(14);
      const databasePath = organizationWorkspaceDatabasePath(root, input.selection.organizationId);
      NodeFS.mkdirSync(NodePath.dirname(databasePath), { recursive: true });
      new NodeSqlite.DatabaseSync(databasePath).close();

      yield* store.initialize();
      yield* store.initialize();
      yield* store.bootstrap(input);
      yield* store.bootstrap(input);

      const control = new NodeSqlite.DatabaseSync(NodePath.join(root, "control.sqlite"), {
        readOnly: true,
      });
      const controlMigrations = control
        .prepare("SELECT COUNT(*) AS count FROM auldric_control_schema_migrations")
        .get() as unknown as { readonly count: number };
      control.close();
      const organization = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
      const organizationMigrations = organization
        .prepare("SELECT COUNT(*) AS count FROM auldric_organization_schema_migrations")
        .get() as unknown as { readonly count: number };
      organization.close();
      assert.equal(controlMigrations.count, 1);
      assert.equal(organizationMigrations.count, 3);
    }),
  );

  it.effect("rejects forward, partial, and crash-state schemas before activation", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now.epochMilliseconds);

      const forwardControlRoot = makeRoot();
      const forwardControlStore = makeStore(forwardControlRoot);
      yield* forwardControlStore.initialize();
      const control = new NodeSqlite.DatabaseSync(
        NodePath.join(forwardControlRoot, "control.sqlite"),
      );
      control
        .prepare(
          "INSERT INTO auldric_control_schema_migrations(version, applied_at) VALUES (2, 'future')",
        )
        .run();
      control.close();
      const forwardControl = yield* forwardControlStore.initialize().pipe(Effect.flip);
      assert.equal(forwardControl._tag, "MarketingWorkspaceStoreError");

      const partialControlRoot = makeRoot();
      const partialControl = new NodeSqlite.DatabaseSync(
        NodePath.join(partialControlRoot, "control.sqlite"),
      );
      partialControl.exec("CREATE TABLE interrupted_migration(value TEXT);");
      partialControl.close();
      const partialControlError = yield* makeStore(partialControlRoot)
        .initialize()
        .pipe(Effect.flip);
      assert.equal(partialControlError._tag, "MarketingWorkspaceStoreError");

      const forwardRoot = makeRoot();
      const forwardInput = bootstrapInput(15);
      createOrganizationSchemaV1(forwardRoot, forwardInput.selection, [1, 2]);
      const forward = yield* makeStore(forwardRoot).backfill(forwardInput).pipe(Effect.flip);
      assert.equal(forward._tag, "MarketingWorkspaceUnavailableError");
      if (forward._tag === "MarketingWorkspaceUnavailableError") {
        assert.equal(forward.reason, "workspace_database_schema_stale");
      }

      const crashRoot = makeRoot();
      const crashInput = bootstrapInput(16);
      const crashPath = organizationWorkspaceDatabasePath(
        crashRoot,
        crashInput.selection.organizationId,
      );
      NodeFS.mkdirSync(NodePath.dirname(crashPath), { recursive: true });
      const crash = new NodeSqlite.DatabaseSync(crashPath);
      crash.exec(`
        CREATE TABLE auldric_organization_schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
        INSERT INTO auldric_organization_schema_migrations(version, applied_at)
        VALUES (1, 'interrupted');
      `);
      crash.close();
      const crashError = yield* makeStore(crashRoot).bootstrap(crashInput).pipe(Effect.flip);
      assert.equal(crashError._tag, "MarketingWorkspaceUnavailableError");
      const crashControl = new NodeSqlite.DatabaseSync(NodePath.join(crashRoot, "control.sqlite"), {
        readOnly: true,
      });
      const row = crashControl
        .prepare("SELECT state FROM marketing_workspaces WHERE id = ?")
        .get(crashInput.selection.workspaceId) as unknown as { readonly state: string };
      crashControl.close();
      assert.equal(row.state, "unavailable");
    }),
  );

  it.effect("backfills only an exact current organization database", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now.epochMilliseconds);
      const root = makeRoot();
      const input = bootstrapInput(17);
      const databasePath = createOrganizationSchemaV1(root, input.selection);
      const store = makeStore(root);

      const binding = yield* store.backfill(input);
      assert.equal(binding.origin, "backfilled");
      assert.equal(
        yield* databaseResolver(store)(
          { requestAuthority: input.requestAuthority, selection: input.selection },
          ({ databasePath: resolvedPath }) => Effect.succeed(resolvedPath),
        ),
        databasePath,
      );
    }),
  );

  it.effect("includes expiresAt in T3-reference idempotency semantics", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now.epochMilliseconds);
      const store = makeStore(makeRoot());
      const owner = bootstrapInput(18);
      yield* store.bootstrap(owner);
      const bindingId = MarketingT3ReferenceBindingId.make(`mt3r_${uuid(18)}`);
      const base = {
        requestAuthority: owner.requestAuthority,
        selection: owner.selection,
        bindingId,
        target: {
          kind: "artifact" as const,
          id: MarketingArtifactId.make(`mart_${uuid(18)}`),
        },
        reference: { kind: "thread" as const, value: ThreadId.make("thread-18") },
        expiresAt: DateTime.makeUnsafe("2030-01-02T00:00:00.000Z"),
      };

      const first = yield* store.linkT3Reference(base);
      assert.deepEqual(yield* store.linkT3Reference(base), first);
      const changedExpiry = yield* store
        .linkT3Reference({
          ...base,
          expiresAt: DateTime.makeUnsafe("2030-01-03T00:00:00.000Z"),
        })
        .pipe(Effect.flip);
      assert.equal(changedExpiry._tag, "MarketingWorkspaceConflictError");
      if (changedExpiry._tag === "MarketingWorkspaceConflictError") {
        assert.equal(changedExpiry.reason, "t3_reference_binding_conflict");
      }
    }),
  );

  it.effect("requests an explicit lifecycle permission for every privileged operation", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now.epochMilliseconds);
      const observed: Array<MarketingWorkspaceAuthorizationRequirement> = [];
      const root = makeRoot();
      const store = makeStore(root, observed);
      const owner = bootstrapInput(19);
      const binding = yield* store.bootstrap(owner);
      const invitedAuthority = requestAuthority(
        119,
        new Set<MarketingWorkspacePermission>(["join-existing-organization"]),
        owner.selection.organizationId,
      );
      const invited = yield* store.join({
        requestAuthority: invitedAuthority,
        selection: owner.selection,
      });
      yield* store.resolve(
        { requestAuthority: owner.requestAuthority, selection: owner.selection },
        () => Effect.void,
      );
      const bindingId = MarketingT3ReferenceBindingId.make(`mt3r_${uuid(19)}`);
      yield* store.linkT3Reference({
        requestAuthority: owner.requestAuthority,
        selection: owner.selection,
        bindingId,
        target: {
          kind: "artifact",
          id: MarketingArtifactId.make(`mart_${uuid(19)}`),
        },
        reference: { kind: "thread", value: ThreadId.make("thread-19") },
      });
      yield* store.markT3ReferenceStale({
        requestAuthority: owner.requestAuthority,
        selection: owner.selection,
        bindingId,
      });
      yield* store.deleteT3Reference({
        requestAuthority: owner.requestAuthority,
        selection: owner.selection,
        bindingId,
      });
      yield* store.revokeMembership({
        requestAuthority: owner.requestAuthority,
        selection: owner.selection,
        targetMarketingActorId: invited.marketingActorId,
      });
      assert.isFalse(
        yield* store.rollbackProvisioning({
          requestAuthority: owner.requestAuthority,
          selection: selection(120),
        }),
      );

      const backfillInput = bootstrapInput(121);
      createOrganizationSchemaV1(root, backfillInput.selection);
      yield* store.backfill(backfillInput);
      assert.isTrue(
        yield* store.deleteOrganizationWorkspace({
          requestAuthority: owner.requestAuthority,
          selection: owner.selection,
        }),
      );

      const permissions = new Set(observed.map((requirement) => requirement.permission));
      assert.deepEqual([...permissions].sort(), [...allPermissions].sort());
      assert.equal(binding.marketingActorId.length, 41);
    }),
  );

  it("keeps generated Marketing actor IDs nominally scoped", () => {
    const acceptActor = (_actor: MarketingActorId): void => undefined;
    // @ts-expect-error A T3 thread ID cannot become a Marketing actor ID.
    acceptActor(ThreadId.make("thread-not-an-actor"));
  });
});
