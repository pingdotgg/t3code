// @effect-diagnostics nodeBuiltinImport:off - these tests inspect disposable physical SQLite boundaries directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { afterEach, assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import {
  MarketingActorId,
  MarketingArtifactId,
  MarketingIdempotencyKey,
  MarketingOrganizationId,
  MarketingProjectId,
  MarketingT3ReferenceBindingId,
  MarketingWorkspaceId,
  T3ActorIssuer,
  T3ActorSubject,
  T3ActorVerificationId,
  type MarketingWorkspaceSelection,
  type VerifiedT3ActorRef,
} from "./identity.ts";
import {
  makeOrganizationWorkspaceStore,
  organizationWorkspaceDatabasePath,
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

function actor(seed: number, expiresAt = "2030-01-01T01:00:00.000Z"): VerifiedT3ActorRef {
  return {
    issuer: T3ActorIssuer.make("https://identity.t3.codes"),
    subject: T3ActorSubject.make(`user_${seed}`),
    verificationId: T3ActorVerificationId.make(`verification_${seed}`),
    verifiedAt: DateTime.makeUnsafe("2029-12-31T23:59:00.000Z"),
    expiresAt: DateTime.makeUnsafe(expiresAt),
  };
}

function provisionInput(seed: number) {
  return {
    actor: actor(seed),
    marketingActorId: MarketingActorId.make(`mact_${uuid(seed)}`),
    selection: selection(seed),
    idempotencyKey: MarketingIdempotencyKey.make(`provision-${seed}`),
  };
}

function createBackfillDatabase(
  root: string,
  input: ReturnType<typeof provisionInput>,
  options: { readonly includeMigration?: boolean } = {},
): string {
  const databasePath = organizationWorkspaceDatabasePath(root, input.selection.organizationId);
  const databaseKey = NodePath.basename(NodePath.dirname(databasePath));
  NodeFS.mkdirSync(NodePath.dirname(databasePath), { recursive: true });
  const database = new NodeSqlite.DatabaseSync(databasePath);
  database.exec(`
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
       ) VALUES (1, ?, ?, ?)`,
    )
    .run(input.selection.organizationId, databaseKey, "existing");
  database
    .prepare(
      `INSERT INTO auldric_marketing_workspace_registry(
         workspace_id, organization_id, project_id, created_at
       ) VALUES (?, ?, ?, ?)`,
    )
    .run(
      input.selection.workspaceId,
      input.selection.organizationId,
      input.selection.projectId,
      "existing",
    );
  if (options.includeMigration ?? true) {
    database.exec(`
      CREATE TABLE auldric_organization_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      INSERT INTO auldric_organization_schema_migrations(version, applied_at)
      VALUES (1, 'existing');
    `);
  }
  database.close();
  return databasePath;
}

describe("organization Marketing workspace store", () => {
  it.effect("creates one physical organization database and resolves it idempotently", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now.epochMilliseconds);
      const root = makeRoot();
      const store = makeOrganizationWorkspaceStore({ stateRoot: root });
      const input = provisionInput(1);

      const first = yield* store.provision(input);
      const second = yield* store.provision(input);
      assert.deepEqual(second, first);

      const resolvedPath = yield* store.resolve(
        { actor: input.actor, selection: input.selection },
        ({ database, databasePath }) =>
          Effect.sync(() => {
            database.exec("CREATE TABLE canonical_probe(value TEXT NOT NULL);");
            database.prepare("INSERT INTO canonical_probe(value) VALUES (?)").run("organization-1");
            return databasePath;
          }),
      );

      assert.equal(
        resolvedPath,
        organizationWorkspaceDatabasePath(root, input.selection.organizationId),
      );
      assert.isTrue(NodeFS.existsSync(resolvedPath));
      assert.isTrue(NodeFS.existsSync(NodePath.join(root, "control.sqlite")));

      const control = new NodeSqlite.DatabaseSync(NodePath.join(root, "control.sqlite"), {
        readOnly: true,
      });
      const rows = control
        .prepare("SELECT COUNT(*) AS count FROM marketing_workspaces")
        .get() as unknown as { readonly count: number };
      control.close();
      assert.equal(rows.count, 1);
    }),
  );

  it.effect("fails closed without a verified request actor and after verification expiry", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now.epochMilliseconds);
      const store = makeOrganizationWorkspaceStore({ stateRoot: makeRoot() });
      const input = provisionInput(2);
      yield* store.provision(input);

      const missing = yield* store
        .resolve({ actor: null, selection: input.selection }, () => Effect.void)
        .pipe(Effect.flip);
      assert.equal(missing._tag, "MarketingActorResolutionError");
      if (missing._tag === "MarketingActorResolutionError") {
        assert.equal(missing.reason, "missing_verified_actor");
      }

      yield* TestClock.setTime(DateTime.makeUnsafe("2030-01-01T02:00:00.000Z").epochMilliseconds);
      const expired = yield* store
        .resolve({ actor: input.actor, selection: input.selection }, () => Effect.void)
        .pipe(Effect.flip);
      assert.equal(expired._tag, "MarketingActorResolutionError");
      if (expired._tag === "MarketingActorResolutionError") {
        assert.equal(expired.reason, "verification_expired");
      }
    }),
  );

  it.effect("does not authorize cross-organization workspace identifiers", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now.epochMilliseconds);
      const store = makeOrganizationWorkspaceStore({ stateRoot: makeRoot() });
      const first = provisionInput(3);
      const second = provisionInput(4);
      yield* store.provision(first);
      yield* store.provision(second);

      const mixedSelection: MarketingWorkspaceSelection = {
        ...first.selection,
        workspaceId: second.selection.workspaceId,
      };
      const error = yield* store
        .resolve({ actor: first.actor, selection: mixedSelection }, () => Effect.void)
        .pipe(Effect.flip);

      assert.equal(error._tag, "MarketingWorkspaceCrossOrganizationError");
    }),
  );

  it.effect("rejects a database copied from another organization", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now.epochMilliseconds);
      const root = makeRoot();
      const store = makeOrganizationWorkspaceStore({ stateRoot: root });
      const first = provisionInput(5);
      const second = provisionInput(6);
      yield* store.provision(first);
      yield* store.provision(second);

      const firstPath = organizationWorkspaceDatabasePath(root, first.selection.organizationId);
      const secondPath = organizationWorkspaceDatabasePath(root, second.selection.organizationId);
      NodeFS.copyFileSync(secondPath, firstPath);

      const error = yield* store
        .resolve({ actor: first.actor, selection: first.selection }, () => Effect.void)
        .pipe(Effect.flip);
      assert.equal(error._tag, "MarketingWorkspaceUnavailableError");
      if (error._tag === "MarketingWorkspaceUnavailableError") {
        assert.equal(error.reason, "workspace_database_identity_mismatch");
      }
    }),
  );

  it.effect(
    "reports an unavailable physical database without using the control database as fallback",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(now.epochMilliseconds);
        const root = makeRoot();
        const store = makeOrganizationWorkspaceStore({ stateRoot: root });
        const input = provisionInput(7);
        yield* store.provision(input);
        const workspacePath = organizationWorkspaceDatabasePath(
          root,
          input.selection.organizationId,
        );
        NodeFS.unlinkSync(workspacePath);

        const error = yield* store
          .resolve({ actor: input.actor, selection: input.selection }, () => Effect.void)
          .pipe(Effect.flip);
        assert.equal(error._tag, "MarketingWorkspaceUnavailableError");
        if (error._tag === "MarketingWorkspaceUnavailableError") {
          assert.equal(error.reason, "workspace_database_missing");
        }
        assert.isTrue(NodeFS.existsSync(NodePath.join(root, "control.sqlite")));

        const replayError = yield* store.provision(input).pipe(Effect.flip);
        assert.equal(replayError._tag, "MarketingWorkspaceUnavailableError");
        if (replayError._tag === "MarketingWorkspaceUnavailableError") {
          assert.equal(replayError.reason, "workspace_database_missing");
        }
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

  it.effect("rejects idempotency-key reuse for a different identity operation", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now.epochMilliseconds);
      const store = makeOrganizationWorkspaceStore({ stateRoot: makeRoot() });
      const first = provisionInput(8);
      yield* store.provision(first);
      const conflicting = {
        ...provisionInput(9),
        idempotencyKey: first.idempotencyKey,
      };

      const error = yield* store.provision(conflicting).pipe(Effect.flip);
      assert.equal(error._tag, "MarketingWorkspaceConflictError");
      if (error._tag === "MarketingWorkspaceConflictError") {
        assert.equal(error.reason, "idempotency_key_reused");
      }
    }),
  );

  it.effect("revokes membership without rewriting the actor or organization identity", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now.epochMilliseconds);
      const store = makeOrganizationWorkspaceStore({ stateRoot: makeRoot() });
      const input = provisionInput(10);
      yield* store.provision(input);

      assert.isTrue(
        yield* store.revokeMembership({
          organizationId: input.selection.organizationId,
          marketingActorId: input.marketingActorId,
        }),
      );
      assert.isFalse(
        yield* store.revokeMembership({
          organizationId: input.selection.organizationId,
          marketingActorId: input.marketingActorId,
        }),
      );

      const error = yield* store
        .resolve({ actor: input.actor, selection: input.selection }, () => Effect.void)
        .pipe(Effect.flip);
      assert.equal(error._tag, "MarketingActorResolutionError");
      if (error._tag === "MarketingActorResolutionError") {
        assert.equal(error.reason, "membership_revoked");
      }
    }),
  );

  it.effect(
    "deletes the physical organization database and retains only a control-plane tombstone",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(now.epochMilliseconds);
        const root = makeRoot();
        const store = makeOrganizationWorkspaceStore({ stateRoot: root });
        const input = provisionInput(11);
        yield* store.provision(input);
        const workspacePath = organizationWorkspaceDatabasePath(
          root,
          input.selection.organizationId,
        );

        assert.isTrue(yield* store.deleteOrganizationWorkspace(input.selection));
        assert.isFalse(NodeFS.existsSync(workspacePath));
        assert.isFalse(yield* store.deleteOrganizationWorkspace(input.selection));

        const error = yield* store
          .resolve({ actor: input.actor, selection: input.selection }, () => Effect.void)
          .pipe(Effect.flip);
        assert.equal(error._tag, "MarketingWorkspaceUnavailableError");
      }),
  );

  it.effect("runs control and organization migrations idempotently", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now.epochMilliseconds);
      const root = makeRoot();
      const store = makeOrganizationWorkspaceStore({ stateRoot: root });
      const input = provisionInput(12);

      yield* store.initialize();
      yield* store.initialize();
      yield* store.provision(input);
      yield* store.provision(input);

      const control = new NodeSqlite.DatabaseSync(NodePath.join(root, "control.sqlite"), {
        readOnly: true,
      });
      const controlMigrations = control
        .prepare("SELECT COUNT(*) AS count FROM auldric_control_schema_migrations")
        .get() as unknown as { readonly count: number };
      control.close();

      const organization = new NodeSqlite.DatabaseSync(
        organizationWorkspaceDatabasePath(root, input.selection.organizationId),
        { readOnly: true },
      );
      const organizationMigrations = organization
        .prepare("SELECT COUNT(*) AS count FROM auldric_organization_schema_migrations")
        .get() as unknown as { readonly count: number };
      organization.close();

      assert.equal(controlMigrations.count, 1);
      assert.equal(organizationMigrations.count, 1);
    }),
  );

  it.effect("backfills only an exact, current organization database", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now.epochMilliseconds);
      const root = makeRoot();
      const store = makeOrganizationWorkspaceStore({ stateRoot: root });
      const input = provisionInput(13);
      const databasePath = createBackfillDatabase(root, input);

      const binding = yield* store.backfill(input);
      assert.equal(binding.origin, "backfilled");
      assert.equal(
        yield* store.resolve(
          { actor: input.actor, selection: input.selection },
          ({ databasePath: resolvedPath }) => Effect.succeed(resolvedPath),
        ),
        databasePath,
      );
    }),
  );

  it.effect("rejects stale backfill schemas and rolls their routing state back idempotently", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now.epochMilliseconds);
      const root = makeRoot();
      const store = makeOrganizationWorkspaceStore({ stateRoot: root });
      const input = provisionInput(14);
      const databasePath = createBackfillDatabase(root, input, { includeMigration: false });

      const error = yield* store.backfill(input).pipe(Effect.flip);
      assert.equal(error._tag, "MarketingWorkspaceUnavailableError");
      if (error._tag === "MarketingWorkspaceUnavailableError") {
        assert.equal(error.reason, "workspace_database_schema_stale");
      }
      assert.isTrue(yield* store.rollbackProvisioning(input.selection));
      assert.isFalse(yield* store.rollbackProvisioning(input.selection));
      assert.isTrue(NodeFS.existsSync(databasePath));
    }),
  );

  it.effect("does not remap one verified T3 actor to a second Marketing actor", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now.epochMilliseconds);
      const store = makeOrganizationWorkspaceStore({ stateRoot: makeRoot() });
      const first = provisionInput(15);
      const remap = { ...provisionInput(16), actor: first.actor };
      yield* store.provision(first);

      const error = yield* store.provision(remap).pipe(Effect.flip);
      assert.equal(error._tag, "MarketingWorkspaceConflictError");
      if (error._tag === "MarketingWorkspaceConflictError") {
        assert.equal(error.reason, "actor_already_mapped");
      }
    }),
  );

  it.effect(
    "erases optional T3 references after explicit stale and deleted lifecycle transitions",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(now.epochMilliseconds);
        const root = makeRoot();
        const store = makeOrganizationWorkspaceStore({ stateRoot: root });
        const owner = provisionInput(17);
        const outsider = provisionInput(18);
        yield* store.provision(owner);
        yield* store.provision(outsider);

        const bindingId = MarketingT3ReferenceBindingId.make(`mt3r_${uuid(17)}`);
        const target = {
          kind: "artifact" as const,
          id: MarketingArtifactId.make(`mart_${uuid(17)}`),
        };
        const reference = { kind: "thread" as const, value: ThreadId.make("thread-17") };
        const linkInput = {
          actor: owner.actor,
          selection: owner.selection,
          bindingId,
          target,
          reference,
        };

        const active = yield* store.linkT3Reference(linkInput);
        assert.equal(active.state, "active");
        assert.deepEqual(yield* store.linkT3Reference(linkInput), active);

        const crossOrganization = yield* store
          .linkT3Reference({
            ...linkInput,
            actor: outsider.actor,
            selection: outsider.selection,
          })
          .pipe(Effect.flip);
        assert.equal(crossOrganization._tag, "MarketingWorkspaceCrossOrganizationError");

        const stale = yield* store.markT3ReferenceStale({
          actor: owner.actor,
          selection: owner.selection,
          bindingId,
        });
        assert.equal(stale.state, "stale");
        assert.deepEqual(
          yield* store.markT3ReferenceStale({
            actor: owner.actor,
            selection: owner.selection,
            bindingId,
          }),
          stale,
        );

        const deleted = yield* store.deleteT3Reference({
          actor: owner.actor,
          selection: owner.selection,
          bindingId,
        });
        assert.equal(deleted.state, "deleted");
        assert.isNull(deleted.reference);
        assert.deepEqual(
          yield* store.deleteT3Reference({
            actor: owner.actor,
            selection: owner.selection,
            bindingId,
          }),
          deleted,
        );

        const control = new NodeSqlite.DatabaseSync(NodePath.join(root, "control.sqlite"), {
          readOnly: true,
        });
        const row = control
          .prepare(
            `SELECT reference_kind AS referenceKind, reference_value AS referenceValue
           FROM marketing_t3_reference_bindings WHERE id = ?`,
          )
          .get(bindingId) as unknown as {
          readonly referenceKind: string | null;
          readonly referenceValue: string | null;
        };
        control.close();
        assert.isNull(row.referenceKind);
        assert.isNull(row.referenceValue);
      }),
  );
});
