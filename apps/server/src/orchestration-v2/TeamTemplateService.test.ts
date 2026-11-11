import { assert, it } from "@effect/vitest";
import {
  CommandId,
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

import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
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

function makeHarness() {
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
  const layerTeamTemplate = TeamTemplate.layer.pipe(
    Layer.provide(Layer.mergeAll(layerProjects, layerThreadManagement, IdAllocator.layer)),
  );
  return Layer.mergeAll(
    layerTeamTemplate,
    layerThreadManagement,
    layerRegistry,
    ProviderRegistryMock.layer(),
    layerDatabase,
  );
}

it.effect("launches pinned Workshop seats as durable idle threads", () =>
  Effect.gen(function* () {
    const service = yield* TeamTemplate.TeamTemplateService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const result = yield* service.launch({
      commandId: CommandId.make("command:workshop"),
      projectId,
      templateId: WORKSHOP_TEAM_TEMPLATE.id,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
    });

    assert.equal(result.templateId, "workshop");
    assert.deepEqual(
      result.seats.map((seat) => seat.seatId),
      ["lead", "builder", "qa", "reviewer"],
    );
    assert.deepEqual(
      result.seats.map((seat) => seat.title),
      WORKSHOP_TEAM_TEMPLATE.seats.map((seat) => seat.title),
    );

    for (const seat of result.seats) {
      const shell = yield* threads.getThreadShell(seat.threadId);
      assert.isNotNull(shell);
      assert.equal(shell?.projectId, projectId);
      assert.equal(shell?.title, seat.title);
      assert.isNotNull(shell?.pinnedAt);
      assert.equal(shell?.status, "idle");
    }
  }).pipe(Effect.provide(makeHarness())),
);

it.effect("fails when the project is missing", () =>
  Effect.gen(function* () {
    const service = yield* TeamTemplate.TeamTemplateService;
    const error = yield* service
      .launch({
        commandId: CommandId.make("command:missing-project"),
        projectId: ProjectId.make("project:missing"),
        templateId: "workshop",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
      })
      .pipe(Effect.flip);
    assert.equal(error._tag, "OrchestrationV2LaunchTeamTemplateError");
    assert.match(error.message, /Project not found/);
  }).pipe(Effect.provide(makeHarness())),
);
