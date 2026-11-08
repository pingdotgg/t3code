#!/usr/bin/env node
import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CodexSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as CodexTextGeneration from "../../apps/server/src/textGeneration/CodexTextGeneration.ts";
import * as ServerConfig from "../../apps/server/src/config.ts";
import { gradeProjectIcon } from "./grade.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    model: { type: "string" },
    out: { type: "string" },
    baseline: { type: "string" },
    case: { type: "string" },
  },
});
if (!values.model || !values.out) throw new Error("Use --model <model> --out <directory>.");
const model = values.model;
const outputDirectory = values.out;
const decodeSettings = Schema.decodeUnknownSync(CodexSettings);
const encodeReport = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeResults = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        sample: Schema.Number,
        name: Schema.String,
        color: Schema.String,
        passed: Schema.Boolean,
      }),
    ),
  ),
);
const fixtures = [
  {
    id: "websocket-server",
    source: "Project icon autofill: backend service over websockets",
    projectTitle: "Realtime dashboard backend",
    threadTitles: ["Add websocket gateway", "Persist session state", "Deploy with Docker"],
    topLevelEntries: ["src", "Dockerfile", "package.json", "README.md"],
    readmeExcerpt: "# Realtime dashboard backend\nWebSocket gateway with Redis pub/sub.",
    packageJsonExcerpt: '{"name":"dashboard-backend","dependencies":{"ws":"^8.0.0"}}',
  },
  {
    id: "mobile-notes",
    source: "Project icon autofill control: mobile notes app",
    projectTitle: "Pocket notes",
    threadTitles: ["Offline sync for notes", "Fix Android keyboard overlap"],
    topLevelEntries: ["App.tsx", "app.json", "package.json", "assets"],
    readmeExcerpt: "# Pocket notes\nOffline-first notes for iOS and Android.",
    packageJsonExcerpt: '{"name":"pocket-notes","dependencies":{"expo":"^52.0.0"}}',
  },
  {
    id: "empty-project",
    source: "Project icon autofill control: no signal beyond the name",
    projectTitle: "Untitled experiments",
    threadTitles: [],
    topLevelEntries: [],
    readmeExcerpt: undefined,
    packageJsonExcerpt: undefined,
  },
];
const selectedFixtures = fixtures.filter(
  (fixture) => values.case === undefined || fixture.id === values.case,
);
if (selectedFixtures.length === 0) {
  throw new Error(
    `Unknown --case ${values.case}. Available cases: ${fixtures.map((fixture) => fixture.id).join(", ")}`,
  );
}

await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseline = values.baseline
      ? yield* fs.readFileString(values.baseline).pipe(Effect.tap(decodeResults))
      : undefined;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-icon-eval-" });
    const generation = yield* CodexTextGeneration.makeCodexTextGeneration(decodeSettings({}));
    const results = [];
    for (const fixture of selectedFixtures) {
      for (let sample = 0; sample < 3; sample++) {
        const generated = yield* generation.generateProjectIcon({
          cwd,
          projectTitle: fixture.projectTitle,
          threadTitles: fixture.threadTitles,
          topLevelEntries: fixture.topLevelEntries,
          ...(fixture.readmeExcerpt === undefined ? {} : { readmeExcerpt: fixture.readmeExcerpt }),
          ...(fixture.packageJsonExcerpt === undefined
            ? {}
            : { packageJsonExcerpt: fixture.packageJsonExcerpt }),
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model },
        });
        results.push({ id: fixture.id, sample, ...generated, passed: gradeProjectIcon(generated) });
      }
    }
    yield* fs.makeDirectory(outputDirectory, { recursive: true });
    yield* fs.writeFileString(
      path.join(outputDirectory, "results.json"),
      yield* encodeReport(results),
    );
    if (baseline !== undefined) {
      yield* fs.writeFileString(path.join(outputDirectory, "baseline.json"), baseline);
    }
    yield* Effect.log(
      `${results.filter((row) => row.passed).length}/${results.length} passed; results in ${outputDirectory}`,
    );
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-icon-eval-state-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  ),
);
