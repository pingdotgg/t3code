// This crate's hand-made ACP scenarios (testdata/<flavor>-scenarios/<name>/, written by
// tools/make-scenarios.mjs), for the tools that run them through T3's fixture runner.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const CRATE = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));

// `<FLAVOR>_MODEL_SELECTION` in the test kit's fixtures/shared.ts.
const MODEL_SELECTIONS = { grok: { instanceId: "grok", model: "grok-build" } };

/** Name, input, transcript file and model of each scenario of a flavor. */
export function readScenarios(flavor, transcriptName = `${flavor}_transcript.ndjson`) {
  const dir = NodePath.join(CRATE, "testdata", `${flavor}-scenarios`);
  if (!NodeFS.existsSync(dir)) return [];
  return NodeFS.readdirSync(dir)
    .toSorted()
    .map((name) => ({
      name,
      driver: flavor,
      input: JSON.parse(NodeFS.readFileSync(NodePath.join(dir, name, "input.json"), "utf8")),
      transcriptFile: NodePath.join(dir, name, transcriptName),
      modelSelection: MODEL_SELECTIONS[flavor],
    }));
}

/**
 * The vitest lines that run each scenario like a fixture of `itRunsReplayFixtures`, through
 * `run` (an expression taking a `ReplayFixtureCase`), with no output assertions.
 */
export function scenarioTestSource(scenarios, run) {
  return `
for (const scenario of ${JSON.stringify(scenarios)}) {
  it.effect(\`conn scenario \${scenario.name}\`, () =>
    (${run})({
      fixtureName: scenario.name,
      buildInput: () => scenario.input,
      driver: {
        driver: scenario.driver,
        transcriptFile: NodeUrl.pathToFileURL(scenario.transcriptFile),
        modelSelection: scenario.modelSelection,
        assertOutput: () => {},
      },
    }),
  );
}
`;
}
