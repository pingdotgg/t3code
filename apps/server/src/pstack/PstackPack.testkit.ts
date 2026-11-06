import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { BUNDLED_CLAUDE_MODEL_CATALOG } from "../provider/ClaudeModelCatalog.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as PstackPack from "./PstackPack.ts";

export const claudeProvider: ServerProvider = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-25T00:00:00Z",
  slashCommands: [],
  skills: [],
  models: BUNDLED_CLAUDE_MODEL_CATALOG.models.map(({ model }) => model),
};

const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const disabledLayer = Layer.mock(PstackPack.PstackPack)({
  catalog: Effect.undefined,
  expandComposer: (input) => Effect.succeed(input),
});

export const makeFixture = Effect.fn("PstackPackTest.makeFixture")(function* (
  providers: ReadonlyArray<ServerProvider> = [],
  settingsLayer: ReturnType<typeof ServerSettings.layerTest> = ServerSettings.layerTest({
    pstackEnabled: true,
  }),
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pstack-" });
  const sourceRoot = path.join(root, "source");
  const stateDir = path.join(root, "userdata");
  for (const [name, content] of Object.entries({
    "UPSTREAM.json": yield* encodeManifest({
      repository: "fixture",
      commit: "a".repeat(40),
      subtreeHash: "b".repeat(40),
      version: "test",
      files: Object.fromEntries([
        [".gitignore", { sha256: "c".repeat(64), executable: false }],
        ["skills/poteto-mode/scripts/bun.lock", { sha256: "c".repeat(64), executable: false }],
        ["skills/architect/SKILL.md", { sha256: "c".repeat(64), executable: false }],
        ["skills/setup-pstack/SKILL.md", { sha256: "c".repeat(64), executable: false }],
        ["scripts/helper.sh", { sha256: "c".repeat(64), executable: true }],
      ]),
    }),
    "upstream/.gitignore": "node_modules/\n",
    "upstream/skills/poteto-mode/scripts/bun.lock": "lockfile\n",
    "upstream/skills/architect/SKILL.md":
      "---\nname: architect\ndescription: Design: a system.\ndisable-model-invocation: true\n---\nArchitect",
    "upstream/skills/setup-pstack/SKILL.md":
      "---\nname: setup-pstack\ndescription: Configure roles.\n---\n### 5. Write models\n```text\narchitect runners: claude-opus-5-5-xhigh, gpt-6-astra-high-fast\n```\n",
    "upstream/scripts/helper.sh": "#!/bin/sh\nexit 0\n",
  })) {
    const file = path.join(sourceRoot, name);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, content);
  }
  yield* fs.chmod(path.join(sourceRoot, "upstream/scripts/helper.sh"), 0o755);
  const layer = PstackPack.layerFromSource(sourceRoot).pipe(
    Layer.provide(
      Layer.mergeAll(
        ServerConfig.layerTest(root, root),
        settingsLayer,
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getPublishedProviders: Effect.succeed(providers),
        }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed(providers.map((provider) => provider.instanceId)),
        }),
      ),
    ),
  );
  return { layer, settingsLayer, sourceRoot, stateDir };
});
