// @effect-diagnostics nodeBuiltinImport:off - contributor CLI writes portable contract artifacts.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as Schema from "effect/Schema";

import {
  AgentAppCorpus,
  AgentAppResultBundle,
  DriverMessage,
  EnvironmentDisclosure,
  RawMetricSample,
} from "./contracts.ts";

const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

const definitions = [
  {
    fileName: "corpus-v1.schema.json",
    id: "urn:t3code:agent-app-benchmark:v1:corpus",
    title: "Agent-app benchmark corpus v1",
    schema: AgentAppCorpus,
  },
  {
    fileName: "driver-message-v1.schema.json",
    id: "urn:t3code:agent-app-benchmark:v1:driver-message",
    title: "Agent-app benchmark driver message v1",
    schema: DriverMessage,
  },
  {
    fileName: "raw-sample-v1.schema.json",
    id: "urn:t3code:agent-app-benchmark:v1:raw-sample",
    title: "Agent-app benchmark raw metric sample v1",
    schema: RawMetricSample,
  },
  {
    fileName: "environment-v1.schema.json",
    id: "urn:t3code:agent-app-benchmark:v1:environment",
    title: "Agent-app benchmark environment disclosure v1",
    schema: EnvironmentDisclosure,
  },
  {
    fileName: "result-bundle-v1.schema.json",
    id: "urn:t3code:agent-app-benchmark:v1:result-bundle",
    title: "Agent-app benchmark result bundle v1",
    schema: AgentAppResultBundle,
  },
] as const;

function toJsonSchemaDocument(definition: (typeof definitions)[number]) {
  const document = Schema.toJsonSchemaDocument(definition.schema, {
    generateDescriptions: true,
  });
  return {
    $schema: JSON_SCHEMA_DIALECT,
    $id: definition.id,
    title: definition.title,
    ...document.schema,
    $defs: document.definitions,
  };
}

export const AGENT_APP_JSON_SCHEMA_ARTIFACTS = definitions.map((definition) => ({
  fileName: definition.fileName,
  document: toJsonSchemaDocument(definition),
}));

export async function writeAgentAppJsonSchemas(outputDirectory: string): Promise<void> {
  await NodeFSP.mkdir(outputDirectory, { recursive: true });
  await Promise.all(
    AGENT_APP_JSON_SCHEMA_ARTIFACTS.map(({ fileName, document }) =>
      NodeFSP.writeFile(
        NodePath.join(outputDirectory, fileName),
        `${JSON.stringify(document, null, 2)}\n`,
        {
          encoding: "utf8",
          mode: 0o644,
        },
      ),
    ),
  );
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const [outputDirectory] = process.argv.slice(2);
  if (!outputDirectory) {
    process.stderr.write("Usage: json-schema.ts <output-directory>\n");
    process.exitCode = 1;
  } else {
    writeAgentAppJsonSchemas(outputDirectory).catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  }
}
