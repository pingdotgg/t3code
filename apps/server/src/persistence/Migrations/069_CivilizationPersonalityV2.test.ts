import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const seedCitizen = Effect.fn("069_CivilizationPersonalityV2.test.seedCitizen")(function* (
  threadId: string,
  profile: {
    readonly id: string;
    readonly label: string;
    readonly traits: ReadonlyArray<string>;
    readonly styleText: string;
  },
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO civilization_citizens (
      thread_id, project_id, parent_thread_id, relationship_to_parent, root_thread_id,
      generation, lineage_status, observed_only, birth_sequence, last_applied_sequence,
      name_entry_id, name_generator_version, name_base, name_display, name_key, name_pool_id,
      name_environment_revision, name_project_revision,
      profile_entry_id, profile_label, profile_traits_json, profile_style_text, profile_pool_id,
      profile_environment_revision, profile_project_revision,
      title_managed, preserved_title, last_managed_title, title_topic,
      pending_title_command_id, pending_managed_title, pending_title_topic,
      epoch, closed, deleted, revision, created_at, updated_at
    ) VALUES (
      ${threadId}, 'project:migration', NULL, NULL, ${threadId},
      0, 'resolved', 0, 1, 1,
      ${`name:${threadId}`}, 1, ${threadId}, ${threadId}, ${threadId}, 'names',
      3, 4,
      ${profile.id}, ${profile.label}, ${JSON.stringify(profile.traits)}, ${profile.styleText}, 'profiles',
      5, 6,
      0, NULL, NULL, 'topic',
      NULL, NULL, NULL,
      7, 0, 0, 8, '2026-10-16T00:00:00.000Z', '2026-10-16T00:00:00.000Z'
    )
  `;
});

it.effect(
  "migrates Civilization personality snapshots and config overrides to v2 without rerolls",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 68 });

      const v1EnvironmentOverride = {
        version: 1,
        participation: { enabled: true },
        personalities: {
          rendering: "mild",
          selectedPoolId: "legacy-profiles",
          pools: [
            {
              id: "legacy-profiles",
              entries: [
                {
                  id: "calm",
                  label: "Calm",
                  traits: ["calm", "concise"],
                  styleText: "Prefer a calm, concise style without changing task priorities.",
                  weight: 3,
                },
                {
                  id: "custom-measured",
                  label: "Measured",
                  traits: ["measured", "careful"],
                  styleText: "Keep a measured tone.",
                  weight: 1,
                },
              ],
            },
          ],
        },
      };
      yield* sql`
      UPDATE civilization_environment_config
      SET override_json = ${JSON.stringify(v1EnvironmentOverride)}, revision = 9
      WHERE singleton = 1
    `;
      yield* sql`
      INSERT INTO civilization_project_config (project_id, revision, override_json, updated_at)
      VALUES (
        'project:v1', 4,
        ${JSON.stringify({
          version: 1,
          participation: { emergencyOff: true },
          personalities: {
            selectedPoolId: "custom-profiles",
            pools: [
              {
                id: "custom-profiles",
                entries: [
                  {
                    id: "calm",
                    label: "Quiet",
                    traits: ["quiet"],
                    styleText: "Keep this custom style.",
                    weight: 1,
                  },
                ],
              },
            ],
          },
        })},
        '2026-10-16T00:00:00.000Z'
      )
    `;
      const existingV2 = JSON.stringify({ version: 2, participation: { enabled: false } });
      yield* sql`
      INSERT INTO civilization_project_config (project_id, revision, override_json, updated_at)
      VALUES ('project:v2', 2, ${existingV2}, '2026-10-16T00:00:00.000Z')
    `;

      yield* seedCitizen("thread:calm", {
        id: "calm",
        label: "Calm",
        traits: ["calm", "concise"],
        styleText: "Prefer a calm, concise style without changing task priorities.",
      });
      yield* seedCitizen("thread:explanatory", {
        id: "explanatory",
        label: "Explanatory",
        traits: ["explanatory", "structured"],
        styleText: "Prefer mildly explanatory, structured phrasing while staying task-focused.",
      });
      yield* seedCitizen("thread:reserved", {
        id: "reserved",
        label: "Reserved",
        traits: ["reserved", "precise"],
        styleText: "Prefer a reserved, precise presentation without changing task priorities.",
      });
      yield* seedCitizen("thread:conversational", {
        id: "conversational",
        label: "Conversational",
        traits: ["conversational", "restrained"],
        styleText:
          "Prefer mildly conversational wording while remaining restrained and task-focused.",
      });
      yield* seedCitizen("thread:custom", {
        id: "custom-measured",
        label: "Measured",
        traits: ["measured", "careful"],
        styleText: "Keep a measured tone.",
      });
      yield* seedCitizen("thread:custom-calm-id", {
        id: "calm",
        label: "Quiet",
        traits: ["quiet"],
        styleText: "Keep this custom style.",
      });
      yield* seedCitizen("thread:custom-archetype-label", {
        id: "custom-stoic-label",
        label: "Stoic Architect",
        traits: ["custom"],
        styleText: "Keep this other custom style.",
      });

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 69 }), [
        [69, "CivilizationPersonalityV2"],
      ]);

      const columns = yield* sql<{
        readonly name: string;
      }>`PRAGMA table_info(civilization_citizens)`;
      assert.includeMembers(
        columns.map((column) => column.name),
        [
          "profile_rich_label",
          "profile_rich_traits_json",
          "profile_rich_axiom",
          "profile_rich_voice",
          "profile_rich_style_text",
        ],
      );

      const citizens = yield* sql<{
        readonly thread_id: string;
        readonly profile_entry_id: string;
        readonly profile_label: string;
        readonly profile_traits_json: string;
        readonly profile_style_text: string;
        readonly profile_pool_id: string;
        readonly profile_environment_revision: number;
        readonly profile_project_revision: number;
        readonly profile_rich_label: string;
        readonly profile_rich_traits_json: string;
        readonly profile_rich_axiom: string;
        readonly profile_rich_voice: string;
        readonly profile_rich_style_text: string;
      }>`
      SELECT thread_id, profile_entry_id, profile_label, profile_traits_json, profile_style_text,
             profile_pool_id, profile_environment_revision, profile_project_revision,
             profile_rich_label, profile_rich_traits_json, profile_rich_axiom,
             profile_rich_voice, profile_rich_style_text
      FROM civilization_citizens
      ORDER BY thread_id
    `;
      const byThread = new Map(citizens.map((citizen) => [citizen.thread_id, citizen]));
      assert.deepInclude(byThread.get("thread:calm"), {
        profile_entry_id: "calm",
        profile_label: "Calm",
        profile_rich_label: "Stoic Architect",
        profile_rich_traits_json: '["deliberate","composed","structural"]',
        profile_rich_axiom: "Build carefully; clarity and sound structure outlast urgency.",
      });
      assert.deepInclude(byThread.get("thread:explanatory"), {
        profile_rich_label: "Inquisitive Explorer",
        profile_rich_traits_json: '["curious","explanatory","structured"]',
      });
      assert.deepInclude(byThread.get("thread:reserved"), {
        profile_rich_label: "Skeptical Auditor",
        profile_rich_traits_json: '["skeptical","precise","evidence-minded"]',
      });
      assert.deepInclude(byThread.get("thread:conversational"), {
        profile_rich_label: "Pragmatic Craftsman",
        profile_rich_traits_json: '["pragmatic","grounded","craft-focused"]',
      });
      assert.deepInclude(byThread.get("thread:custom"), {
        profile_entry_id: "custom-measured",
        profile_label: "Measured",
        profile_traits_json: '["measured","careful"]',
        profile_style_text: "Keep a measured tone.",
        profile_pool_id: "profiles",
        profile_environment_revision: 5,
        profile_project_revision: 6,
        profile_rich_label: "Measured",
        profile_rich_traits_json: '["measured","careful"]',
        profile_rich_axiom: "Keep the stored personality subordinate to the requested task.",
        profile_rich_voice:
          "Express the stored profile distinctly without changing task priorities.",
        profile_rich_style_text: "Keep a measured tone.",
      });
      assert.deepInclude(byThread.get("thread:custom-calm-id"), {
        profile_entry_id: "calm",
        profile_label: "Quiet",
        profile_rich_label: "Quiet",
        profile_rich_traits_json: '["quiet"]',
        profile_rich_axiom: "Keep the stored personality subordinate to the requested task.",
        profile_rich_voice:
          "Express the stored profile distinctly without changing task priorities.",
        profile_rich_style_text: "Keep this custom style.",
      });
      assert.deepInclude(byThread.get("thread:custom-archetype-label"), {
        profile_entry_id: "custom-stoic-label",
        profile_label: "Stoic Architect",
        profile_rich_label: "Stoic Architect",
        profile_rich_traits_json: '["custom"]',
        profile_rich_axiom: "Keep the stored personality subordinate to the requested task.",
        profile_rich_voice:
          "Express the stored profile distinctly without changing task priorities.",
        profile_rich_style_text: "Keep this other custom style.",
      });

      const environment = (yield* sql<{
        readonly revision: number;
        readonly override_json: string;
      }>`
        SELECT revision, override_json FROM civilization_environment_config WHERE singleton = 1
      `)[0]!;
      assert.equal(environment.revision, 9);
      const migratedEnvironment = JSON.parse(environment.override_json) as {
        readonly version: number;
        personalities: {
          rendering: string;
          pools: Array<{
            entries: Array<{ rich: RichProfileForTest }>;
          }>;
        };
      };
      assert.equal(migratedEnvironment.version, 2);
      assert.equal(migratedEnvironment.personalities.rendering, "mild");
      assert.deepStrictEqual(migratedEnvironment.personalities.pools[0]!.entries[0]!.rich, {
        label: "Stoic Architect",
        traits: ["deliberate", "composed", "structural"],
        axiom: "Build carefully; clarity and sound structure outlast urgency.",
        voice: "Measured, composed, and architectural without becoming ceremonial.",
        styleText:
          "Use a distinctly stoic, architectural voice while staying concise, task-focused, and fully subordinate to the user's instructions.",
      });
      assert.deepStrictEqual(migratedEnvironment.personalities.pools[0]!.entries[1]!.rich, {
        label: "Measured",
        traits: ["measured", "careful"],
        axiom: "Keep the stored personality subordinate to the requested task.",
        voice: "Express the stored Measured profile distinctly without changing task priorities.",
        styleText: "Keep a measured tone.",
      });

      const projectRows = yield* sql<{
        readonly project_id: string;
        readonly revision: number;
        readonly override_json: string;
      }>`
      SELECT project_id, revision, override_json
      FROM civilization_project_config
      ORDER BY project_id
    `;
      const v1Project = projectRows.find((row) => row.project_id === "project:v1")!;
      assert.equal(v1Project.revision, 4);
      const migratedProject = JSON.parse(v1Project.override_json) as {
        readonly version: number;
        readonly participation: { readonly emergencyOff: boolean };
        readonly personalities: {
          readonly pools: ReadonlyArray<{
            readonly entries: ReadonlyArray<{ readonly rich: RichProfileForTest }>;
          }>;
        };
      };
      assert.equal(migratedProject.version, 2);
      assert.isTrue(migratedProject.participation.emergencyOff);
      assert.deepStrictEqual(migratedProject.personalities.pools[0]!.entries[0]!.rich, {
        label: "Quiet",
        traits: ["quiet"],
        axiom: "Keep the stored personality subordinate to the requested task.",
        voice: "Express the stored Quiet profile distinctly without changing task priorities.",
        styleText: "Keep this custom style.",
      });
      assert.equal(
        projectRows.find((row) => row.project_id === "project:v2")!.override_json,
        existingV2,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

type RichProfileForTest = {
  readonly label: string;
  readonly traits: ReadonlyArray<string>;
  readonly axiom: string;
  readonly voice: string;
  readonly styleText: string;
};
