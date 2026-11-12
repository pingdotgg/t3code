import { assert, it } from "@effect/vitest";
import {
  CommandId,
  type ContributorBundle,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  WORKSHOP_TEAM_TEMPLATE,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ContributorBundleLoader from "../project/ContributorBundleLoader.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AgentTeam from "./AgentTeamService.ts";
import * as TeamTemplate from "./TeamTemplateService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const projectId = ProjectId.make("project:team-template");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;
const project = {
  id: projectId,
  title: "Project",
  workspaceRoot: "/repo",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: modelSelection,
  defaultThreadEnvMode: null,
  scripts: [],
  pinnedAt: null,
  archivedAt: null,
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
  deletedAt: null,
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in team template tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const workshopSource = { kind: "builtin" as const, templateId: WORKSHOP_TEAM_TEMPLATE.id };

const sampleBundle = {
  name: "Repo Workshop",
  orientation: {
    summary: "Ship competence with the repo.",
    map: [{ path: "apps/server", purpose: "Orchestration" }],
  },
  seats: [
    { id: "lead", title: "Lead", roleBrief: "Coordinate." },
    { id: "builder", title: "Builder", roleBrief: "Implement." },
  ],
} as const satisfies ContributorBundle;

function makeHarness(bundle: ContributorBundle | null = null) {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([adapter]);
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "team-template" },
    layerRegistry,
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerServerSettings = ServerSettings.layerTest();
  const layerReceipts = CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase));
  const layerThreadManagement = ThreadManagement.layer.pipe(
    Layer.provide(layerOrchestrator),
    Layer.provide(layerServerSettings),
    Layer.provide(layerReceipts),
  );
  const layerProjects = Layer.succeed(ProjectService.ProjectService, {
    create: () => Effect.die("unused"),
    bootstrap: () => Effect.die("unused"),
    update: () => Effect.die("unused"),
    delete: () => Effect.die("unused"),
    listPage: () => Effect.die("unused"),
    getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
    getByWorkspaceRoot: () => Effect.succeedSome(project),
    workspaceScanDirectory: () => Effect.die("unused"),
    snapshot: Effect.die("unused"),
    getShell: () => Effect.die("unused"),
    listShells: () => Effect.die("unused"),
  });
  const layerLoader = Layer.succeed(ContributorBundleLoader.ContributorBundleLoader, {
    load: () => Effect.succeed(bundle === null ? Option.none() : Option.some(bundle)),
  });
  const layerAgentTeam = AgentTeam.layer.pipe(
    Layer.provide(Layer.mergeAll(layerThreadManagement, layerServerSettings)),
  );
  const layerTeamTemplate = TeamTemplate.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerProjects,
        layerLoader,
        layerThreadManagement,
        layerAgentTeam,
        IdAllocator.layer,
      ),
    ),
  );
  return Layer.mergeAll(
    layerTeamTemplate,
    layerAgentTeam,
    layerServerSettings,
    layerThreadManagement,
    layerRegistry,
    ProviderRegistryMock.layer(),
    layerDatabase,
  );
}

it.effect("previews Workshop specialists with durable keys", () =>
  Effect.gen(function* () {
    const service = yield* TeamTemplate.TeamTemplateService;
    const preview = yield* service.preview({
      projectId,
      source: workshopSource,
    });
    assert.equal(preview.name, "Workshop");
    assert.deepEqual(
      preview.specialists.map((seat) => seat.key),
      ["lead", "builder", "qa", "reviewer"],
    );
    assert.isUndefined(preview.specialists[0]?.existingThreadId);
  }).pipe(Effect.provide(makeHarness())),
);

it.effect("adds pinned Workshop specialists with durable bindings", () =>
  Effect.gen(function* () {
    const service = yield* TeamTemplate.TeamTemplateService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const result = yield* service.add({
      commandId: CommandId.make("command:workshop"),
      projectId,
      source: workshopSource,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
    });

    assert.equal(result.name, "Workshop");
    assert.deepEqual(
      result.specialists.map((entry) => entry.specialist.key),
      ["lead", "builder", "qa", "reviewer"],
    );

    for (const entry of result.specialists) {
      const shell = yield* threads.getThreadShell(entry.threadId);
      assert.isNotNull(shell);
      assert.equal(shell?.projectId, projectId);
      assert.equal(shell?.title, entry.title);
      assert.isNotNull(shell?.pinnedAt);
      assert.equal(shell?.status, "idle");
      assert.equal(shell?.specialist?.key, entry.specialist.key);
      assert.equal(shell?.specialist?.label, entry.specialist.label);
      assert.equal(shell?.specialist?.instructions, entry.specialist.instructions);
    }

    const settings = yield* ServerSettings.ServerSettingsService;
    const stored = yield* settings.getSettings;
    const team = stored.agentTeams[projectId];
    assert.isDefined(team);
    assert.equal(team?.name, "Workshop");
    assert.deepEqual(team?.seatKeys, ["lead", "builder", "qa", "reviewer"]);
    assert.equal(team?.leadKey, "lead");
  }).pipe(Effect.provide(makeHarness())),
);

it.effect("refuses a second Workshop add when specialist keys already exist", () =>
  Effect.gen(function* () {
    const service = yield* TeamTemplate.TeamTemplateService;
    yield* service.add({
      commandId: CommandId.make("command:workshop-first"),
      projectId,
      source: workshopSource,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
    });
    const preview = yield* service.preview({
      projectId,
      source: workshopSource,
    });
    assert.isDefined(preview.specialists[0]?.existingThreadId);

    const error = yield* service
      .add({
        commandId: CommandId.make("command:workshop-second"),
        projectId,
        source: workshopSource,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
      })
      .pipe(Effect.flip);
    assert.equal(error._tag, "OrchestrationV2AddSpecialistsFromTemplateError");
    assert.match(error.message, /already bound/);
  }).pipe(Effect.provide(makeHarness())),
);

it.effect("adds specialists from a repo contributor bundle", () =>
  Effect.gen(function* () {
    const service = yield* TeamTemplate.TeamTemplateService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const result = yield* service.add({
      commandId: CommandId.make("command:bundle"),
      projectId,
      source: { kind: "contributor-bundle" },
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
    });

    assert.equal(result.name, "Repo Workshop");
    assert.equal(result.specialists.length, 2);
    assert.match(result.leadPrompt, /Project orientation/);
    const lead = yield* threads.getThreadShell(result.specialists[0]!.threadId);
    assert.equal(lead?.specialist?.key, "lead");
    assert.match(lead?.specialist?.instructions ?? "", /apps\/server/);
  }).pipe(Effect.provide(makeHarness(sampleBundle))),
);

it.effect("fails when the project is missing", () =>
  Effect.gen(function* () {
    const service = yield* TeamTemplate.TeamTemplateService;
    const error = yield* service
      .add({
        commandId: CommandId.make("command:missing-project"),
        projectId: ProjectId.make("project:missing"),
        source: workshopSource,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
      })
      .pipe(Effect.flip);
    assert.equal(error._tag, "OrchestrationV2AddSpecialistsFromTemplateError");
    assert.match(error.message, /Project not found/);
  }).pipe(Effect.provide(makeHarness())),
);
