import { assert, it } from "@effect/vitest";
import {
  CIVILIZATION_CONFIG_VERSION,
  CivilizationDefaultConfig,
  CivilizationConfigConflictError,
  CivilizationConfigInvalidError,
  CivilizationUnavailableError,
  ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ConfigService from "./ConfigService.ts";

const layerDatabase = SqlitePersistence.layerMemory;
const layer = Layer.mergeAll(layerDatabase, ConfigService.layer.pipe(Layer.provide(layerDatabase)));

const insertProject = Effect.fn("ConfigService.test.insertProject")(function* (
  projectId: ProjectId,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
    ) VALUES (
      ${projectId}, ${projectId}, '/tmp/civilization', '[]',
      '2026-10-16T00:00:00.000Z', '2026-10-16T00:00:00.000Z', NULL
    )
  `;
});

const isInvalid = Schema.is(CivilizationConfigInvalidError);
const isConflict = Schema.is(CivilizationConfigConflictError);
const isUnavailable = Schema.is(CivilizationUnavailableError);

it("ships five equally weighted profiles with bounded mild and rich renderings", () => {
  const profiles = CivilizationDefaultConfig.personalities.pools[0]!.entries;
  assert.lengthOf(profiles, 5);
  assert.deepEqual(
    profiles.map((profile) => profile.weight),
    [1, 1, 1, 1, 1],
  );
  assert.isTrue(profiles.every((profile) => profile.traits.length <= 2));
  assert.isTrue(profiles.every((profile) => profile.rich.traits.length <= 16));
  assert.deepEqual(
    profiles.map((profile) => profile.rich.label),
    [
      "Stoic Architect",
      "Inquisitive Explorer",
      "Skeptical Auditor",
      "Pragmatic Craftsman",
      "Obsessive Optimizer",
    ],
  );
});

it.effect("resolves built-in -> environment -> project overrides with provenance", () =>
  Effect.gen(function* () {
    const service = yield* ConfigService.CivilizationConfigService;
    const projectId = ProjectId.make("project:civilization:inheritance");
    yield* insertProject(projectId);

    const defaults = yield* service.getEffective();
    assert.isFalse(defaults.config.participation.enabled);
    assert.equal(defaults.environmentRevision, 0);

    yield* service.set({
      expectedRevision: 0,
      override: {
        version: CIVILIZATION_CONFIG_VERSION,
        participation: { enabled: true },
        context: { rosterCount: 12 },
      },
    });
    yield* service.set({
      projectId,
      expectedRevision: 0,
      override: {
        version: CIVILIZATION_CONFIG_VERSION,
        context: { rosterCount: 4 },
        personalities: { rendering: "mild" },
      },
    });

    const effective = yield* service.getEffective(projectId);
    assert.isTrue(effective.config.participation.enabled);
    assert.equal(effective.config.context.rosterCount, 4);
    assert.equal(effective.config.personalities.rendering, "mild");
    assert.equal(effective.environmentRevision, 1);
    assert.equal(effective.projectRevision, 1);
    assert.equal(
      effective.provenance.find((item) => item.path === "context.rosterCount")?.source,
      "project",
    );
    assert.equal(
      effective.provenance.find((item) => item.path === "participation.enabled")?.source,
      "environment",
    );
  }).pipe(Effect.provide(Layer.fresh(layer))),
);

it.effect(
  "validates weighted pools and prevents environment edits from breaking project references",
  () =>
    Effect.gen(function* () {
      const service = yield* ConfigService.CivilizationConfigService;
      const projectId = ProjectId.make("project:civilization:dependent");
      yield* insertProject(projectId);

      yield* service.set({
        expectedRevision: 0,
        override: {
          version: CIVILIZATION_CONFIG_VERSION,
          names: {
            pools: [
              { id: "main", entries: [{ id: "ada", displayName: "Ada", weight: 1 }] },
              { id: "alt", entries: [{ id: "grace", displayName: "Grace", weight: 1 }] },
            ],
            selectedPoolId: "main",
          },
        },
      });
      yield* service.set({
        projectId,
        expectedRevision: 0,
        override: {
          version: CIVILIZATION_CONFIG_VERSION,
          names: { selectedPoolId: "alt" },
        },
      });

      const badEnvironment = yield* Effect.flip(
        service.set({
          expectedRevision: 1,
          override: {
            version: CIVILIZATION_CONFIG_VERSION,
            names: {
              pools: [{ id: "main", entries: [{ id: "ada", displayName: "Ada", weight: 1 }] }],
              selectedPoolId: "main",
            },
          },
        }),
      );
      assert.isTrue(isInvalid(badEnvironment));
      if (isInvalid(badEnvironment))
        assert.equal(badEnvironment.reason, "dependent_override_invalid");

      const allZero = yield* Effect.flip(
        service.validate({
          override: {
            version: CIVILIZATION_CONFIG_VERSION,
            personalities: {
              pools: [
                {
                  id: "zero",
                  entries: [
                    {
                      id: "quiet",
                      label: "Quiet",
                      traits: [],
                      styleText: "",
                      rich: {
                        label: "Quiet",
                        traits: [],
                        axiom: "Stay quiet and task-focused.",
                        voice: "Quiet and precise.",
                        styleText: "Stay task-focused.",
                      },
                      weight: 0,
                    },
                  ],
                },
              ],
              selectedPoolId: "zero",
              rendering: "off",
            },
          },
        }),
      );
      assert.isTrue(isInvalid(allZero));

      const fixedTitleOverflow = yield* Effect.flip(
        service.validate({
          override: {
            version: CIVILIZATION_CONFIG_VERSION,
            names: { titleTemplate: `${"x".repeat(390)}{name}` },
          },
        }),
      );
      assert.isTrue(isInvalid(fixedTitleOverflow));
      if (isInvalid(fixedTitleOverflow)) {
        assert.equal(fixedTitleOverflow.reason, "invalid_title_template");
      }

      const richStyleOverflow = yield* Effect.flip(
        service.validate({
          override: {
            version: CIVILIZATION_CONFIG_VERSION,
            personalities: {
              pools: [
                {
                  id: "rich-limit",
                  entries: [
                    {
                      id: "bounded",
                      label: "Bounded",
                      traits: [],
                      styleText: "",
                      rich: {
                        label: "Bounded Rich",
                        traits: [],
                        axiom: "Stay within the task.",
                        voice: "Precise and bounded.",
                        styleText: "x".repeat(513),
                      },
                      weight: 1,
                    },
                  ],
                },
              ],
              selectedPoolId: "rich-limit",
            },
          },
        }),
      );
      assert.isTrue(isInvalid(richStyleOverflow));
      if (isInvalid(richStyleOverflow)) assert.equal(richStyleOverflow.reason, "invalid_profile");
    }).pipe(Effect.provide(Layer.fresh(layer))),
);

it.effect("keeps stale revisions and invalid imports atomic", () =>
  Effect.gen(function* () {
    const service = yield* ConfigService.CivilizationConfigService;
    yield* service.set({
      expectedRevision: 0,
      override: { version: CIVILIZATION_CONFIG_VERSION, participation: { enabled: true } },
    });

    const stale = yield* Effect.flip(
      service.set({
        expectedRevision: 0,
        override: { version: CIVILIZATION_CONFIG_VERSION, participation: { enabled: false } },
      }),
    );
    assert.isTrue(isConflict(stale));

    const before = yield* service.getEffective();
    const invalidImport = yield* Effect.flip(
      service.import({ expectedRevision: 1, json: '{"version":1}' }),
    );
    assert.isTrue(isInvalid(invalidImport));
    const unknownNestedField = yield* Effect.flip(
      service.import({
        expectedRevision: 1,
        json: JSON.stringify({
          version: CIVILIZATION_CONFIG_VERSION,
          participation: { enabled: true, unsupportedField: true },
        }),
      }),
    );
    assert.isTrue(isInvalid(unknownNestedField));
    const after = yield* service.getEffective();
    assert.deepEqual(after, before);
  }).pipe(Effect.provide(Layer.fresh(layer))),
);

it.effect(
  "fails persisted logical corruption closed without revalidating untouched built-in pools",
  () =>
    Effect.gen(function* () {
      const service = yield* ConfigService.CivilizationConfigService;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`
      UPDATE civilization_environment_config
      SET revision = 1,
          override_json = ${JSON.stringify({
            version: CIVILIZATION_CONFIG_VERSION,
            context: { packetBytes: 999_999 },
          })}
      WHERE singleton = 1
    `;
      const badScalar = yield* Effect.flip(service.getEffective());
      assert.isTrue(isUnavailable(badScalar));
      if (isUnavailable(badScalar)) assert.equal(badScalar.reason, "corrupt_state");

      yield* sql`
      UPDATE civilization_environment_config
      SET revision = 2,
          override_json = ${JSON.stringify({
            version: CIVILIZATION_CONFIG_VERSION,
            personalities: {
              pools: [
                {
                  id: "broken",
                  entries: [
                    {
                      id: "zero",
                      label: "Zero",
                      traits: [],
                      styleText: "",
                      rich: {
                        label: "Zero Rich",
                        traits: [],
                        axiom: "Stay within the task.",
                        voice: "Quiet and exact.",
                        styleText: "",
                      },
                      weight: 0,
                    },
                  ],
                },
              ],
              selectedPoolId: "broken",
            },
          })}
      WHERE singleton = 1
    `;
      const badPool = yield* Effect.flip(service.getEffective());
      assert.isTrue(isUnavailable(badPool));
      if (isUnavailable(badPool)) assert.equal(badPool.reason, "corrupt_state");
    }).pipe(Effect.provide(Layer.fresh(layer))),
);

it.effect("reset removes the override while advancing its revision", () =>
  Effect.gen(function* () {
    const service = yield* ConfigService.CivilizationConfigService;
    const set = yield* service.set({
      expectedRevision: 0,
      override: { version: CIVILIZATION_CONFIG_VERSION, participation: { enabled: true } },
    });
    assert.equal(set.revision, 1);
    const reset = yield* service.reset({ expectedRevision: 1 });
    assert.equal(reset.revision, 2);
    assert.isFalse(reset.effective.config.participation.enabled);
    const exported = yield* service.export();
    assert.equal(JSON.parse(exported.json).version, CIVILIZATION_CONFIG_VERSION);
    assert.lengthOf(Object.keys(JSON.parse(exported.json)), 1);
  }).pipe(Effect.provide(Layer.fresh(layer))),
);

it.effect("reset recovers corrupt persisted environment and project overrides", () =>
  Effect.gen(function* () {
    const service = yield* ConfigService.CivilizationConfigService;
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make("project:civilization:reset-corrupt");
    yield* insertProject(projectId);
    const corrupt = JSON.stringify({
      version: CIVILIZATION_CONFIG_VERSION,
      context: { packetBytes: 999_999 },
    });
    yield* sql`
      UPDATE civilization_environment_config
      SET revision = 4, override_json = ${corrupt}
      WHERE singleton = 1
    `;

    assert.isTrue(isUnavailable(yield* Effect.flip(service.getEffective())));
    const environmentReset = yield* service.reset({ expectedRevision: 4 });
    assert.equal(environmentReset.revision, 5);
    assert.isFalse(environmentReset.effective.config.participation.enabled);

    yield* sql`
      INSERT INTO civilization_project_config (project_id, revision, override_json, updated_at)
      VALUES (${projectId}, 7, ${corrupt}, datetime('now'))
    `;
    assert.isTrue(isUnavailable(yield* Effect.flip(service.getEffective(projectId))));
    const projectReset = yield* service.reset({ projectId, expectedRevision: 7 });
    assert.equal(projectReset.revision, 8);
    assert.isFalse(projectReset.effective.config.participation.enabled);
  }).pipe(Effect.provide(Layer.fresh(layer))),
);

it.effect("invalidates the runtime config cache after supported writes", () =>
  Effect.gen(function* () {
    const service = yield* ConfigService.CivilizationConfigService;
    const projectId = ProjectId.make("project:civilization:runtime-cache");
    yield* insertProject(projectId);

    const initial = yield* service.getRuntime(projectId);
    assert.equal(initial.projectRevision, 0);
    assert.equal(initial.config.personalities.rendering, "off");

    yield* service.set({
      projectId,
      expectedRevision: 0,
      override: {
        version: CIVILIZATION_CONFIG_VERSION,
        personalities: { rendering: "rich" },
      },
    });

    const updated = yield* service.getRuntime(projectId);
    assert.equal(updated.projectRevision, 1);
    assert.equal(updated.config.personalities.rendering, "rich");

    yield* service.reset({ projectId, expectedRevision: 1 });
    const reset = yield* service.getRuntime(projectId);
    assert.equal(reset.projectRevision, 2);
    assert.equal(reset.config.personalities.rendering, "off");
  }).pipe(Effect.provide(Layer.fresh(layer))),
);
