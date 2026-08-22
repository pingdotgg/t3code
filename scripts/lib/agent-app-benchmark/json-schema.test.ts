// @effect-diagnostics nodeBuiltinImport:off - contract tests inspect committed documentation artifacts.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  decodeAgentAppCorpus,
  decodeDriverMessage,
  decodeRawMetricSample,
  decodeResultBundle,
  EnvironmentDisclosure,
} from "./contracts.ts";
import { AGENT_APP_JSON_SCHEMA_ARTIFACTS } from "./json-schema.ts";

const repositoryRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../..",
);
const benchmarkDirectory = NodePath.join(repositoryRoot, "benchmarks/agent-app");
const decodeEnvironmentDisclosure = Schema.decodeUnknownSync(EnvironmentDisclosure);

function readJson(relativePath: string): unknown {
  return JSON.parse(NodeFS.readFileSync(NodePath.join(benchmarkDirectory, relativePath), "utf8"));
}

describe("agent-app benchmark portable contracts", () => {
  it("keeps committed Draft 2020-12 artifacts generated from the Effect schemas", () => {
    for (const artifact of AGENT_APP_JSON_SCHEMA_ARTIFACTS) {
      assert.deepStrictEqual(readJson(`schemas/${artifact.fileName}`), artifact.document);
    }
  });

  it("decodes every complete documentation example with the authoritative contracts", () => {
    assert.doesNotThrow(() => decodeAgentAppCorpus(readJson("examples/corpus-v1.json")));
    assert.doesNotThrow(() => decodeDriverMessage(readJson("examples/hello-request-v1.json")));
    assert.doesNotThrow(() => decodeDriverMessage(readJson("examples/hello-response-v1.json")));
    assert.doesNotThrow(() => decodeRawMetricSample(readJson("examples/raw-sample-v1.json")));
    assert.doesNotThrow(() =>
      decodeEnvironmentDisclosure(readJson("examples/environment-v1.json")),
    );
    assert.doesNotThrow(() => decodeResultBundle(readJson("examples/result-bundle-v1.json")));
  });

  it("decodes every inline JSON protocol example in the README", () => {
    const readme = NodeFS.readFileSync(NodePath.join(benchmarkDirectory, "README.md"), "utf8");
    const examples = [...readme.matchAll(/```json\n([\s\S]*?)\n```/gu)].map((match) =>
      JSON.parse(match[1] ?? ""),
    );
    assert.lengthOf(examples, 5);
    for (const example of examples) {
      if ("protocolVersion" in example) {
        assert.doesNotThrow(() => decodeDriverMessage(example));
      } else if ("runId" in example) {
        assert.doesNotThrow(() => decodeResultBundle(example));
      } else {
        assert.doesNotThrow(() => decodeRawMetricSample(example));
      }
    }
  });

  it("links every schema and example from the protocol README", () => {
    const readme = NodeFS.readFileSync(NodePath.join(benchmarkDirectory, "README.md"), "utf8");
    for (const artifact of AGENT_APP_JSON_SCHEMA_ARTIFACTS) {
      assert.include(readme, `schemas/${artifact.fileName}`);
    }
    for (const example of [
      "corpus-v1.json",
      "hello-request-v1.json",
      "hello-response-v1.json",
      "raw-sample-v1.json",
      "environment-v1.json",
      "result-bundle-v1.json",
    ]) {
      assert.include(readme, `examples/${example}`);
    }
  });
});
