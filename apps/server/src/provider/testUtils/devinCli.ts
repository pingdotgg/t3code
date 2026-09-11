import * as NodeServices from "@effect/platform-node/NodeServices";
import { DevinSettings, ServerProviders } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ServerConfig } from "../../config.ts";
import { DevinSkillCatalog } from "../Drivers/DevinSkills.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";

const encodeString = Schema.encodeSync(Schema.fromJsonString(Schema.String));
export const decodeDevinSettings = Schema.decodeSync(DevinSettings);
export const encodeDevinProviders = Schema.encodeSync(Schema.toCodecJson(ServerProviders));
export const encodeDevinSkills = Schema.encodeSync(DevinSkillCatalog);
const Request = Schema.Struct({
  result: Schema.optional(
    Schema.Struct({
      outcome: Schema.optional(
        Schema.Struct({ outcome: Schema.String, optionId: Schema.optional(Schema.String) }),
      ),
    }),
  ),
  method: Schema.optional(Schema.String),
  params: Schema.optional(
    Schema.Struct({
      sessionId: Schema.optional(Schema.String),
      cwd: Schema.optional(Schema.String),
      additionalDirectories: Schema.optional(Schema.Array(Schema.String)),
      workspaceDirs: Schema.optional(Schema.Array(Schema.String)),
      serverId: Schema.optional(Schema.String),
      mcpServers: Schema.optional(
        Schema.Array(
          Schema.Struct({
            type: Schema.String,
            name: Schema.String,
            url: Schema.String,
            headers: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
          }),
        ),
      ),
      modeId: Schema.optional(Schema.String),
      configId: Schema.optional(Schema.String),
      value: Schema.optional(Schema.String),
      prompt: Schema.optional(
        Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
      ),
    }),
  ),
});
export const decodeDevinLaunch = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      args: Schema.Array(Schema.String),
      cwd: Schema.String,
      device: Schema.optional(Schema.String),
    }),
  ),
);
const decodeRequest = Schema.decodeSync(Schema.fromJsonString(Request));
export const devinTestLayer = ServerConfig.layerTest("/tmp", { prefix: "t3-devin-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

export const makeDevinCli = Effect.fn("makeDevinCli")(function* (
  env: Readonly<Record<string, string>> = {},
  version = "devin 3000.5.20 (test)",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcessEnvironment;
  const platform = yield* HostProcessPlatform;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-devin-cli-" });
  const requestLog = path.join(root, "requests.jsonl");
  const launchLog = path.join(root, "launches.jsonl");
  const scriptPath = yield* path.fromFileUrl(
    new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
  );
  const binaryPath = writeFakeCli({
    directory: root,
    name: "devin",
    platform,
    env: {
      T3_ACP_DEVIN: "1",
      ...env,
      T3_ACP_REQUEST_LOG_PATH: requestLog,
    },
    source: `const cliArgs = process.argv.slice(2);
const matches = (...expected) => cliArgs.length === expected.length && cliArgs.every((arg, i) => arg === expected[i]);
if (matches("--version")) { process.stdout.write(${encodeString(version + "\n")}); process.exit(0); }
if (matches("auth", "status")) {
  const statusFile = process.env.T3_DEVIN_AUTH_STATUS_FILE;
  process.stdout.write(statusFile ? (await import("node:fs")).readFileSync(statusFile, "utf8") : process.env.T3_DEVIN_AUTH_STATUS ?? "Not logged in.\\n");
  process.exit(0);
}
if (matches("models", "list", "--format", "json")) {
  if (process.env.T3_DEVIN_FAIL_MODELS === "1") process.exit(1);
  const modelsFile = process.env.T3_DEVIN_MODELS_FILE;
  process.stdout.write(modelsFile ? (await import("node:fs")).readFileSync(modelsFile, "utf8") : JSON.stringify({families: [{slug: "devin-test", family_label: "Devin Test", variants: [
    {model_uid: "devin-test-low", label: "Devin Test Low"},
    {model_uid: "devin-test-high", label: "Devin Test High"}
  ]}]}));
  process.exit(0);
}
if (matches("skills", "list", "--json")) {
  if (process.env.T3_DEVIN_FAIL_SKILLS === "1") process.exit(1);
  const fs = await import("node:fs");
  const skillsFile = process.env.T3_DEVIN_SKILLS_FILE ?? "devin-test-skills.json";
  process.stdout.write(fs.existsSync(skillsFile) ? fs.readFileSync(skillsFile, "utf8") : "[]");
  process.exit(0);
}
if (!matches("acp")) { process.stderr.write("Unexpected Devin CLI arguments: " + JSON.stringify(cliArgs)); process.exit(2); }
const fs = await import("node:fs");
fs.appendFileSync(${encodeString(launchLog)}, JSON.stringify({args: cliArgs, cwd: process.cwd(), device: process.env.T3_TEST_DEVICE}) + "\\n");
${execScriptSource({ scriptPath })}`,
  });
  const settings = decodeDevinSettings({ enabled: true, binaryPath });
  const requests = fs.readFileString(requestLog).pipe(
    Effect.map((text) =>
      text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => decodeRequest(line)),
    ),
  );
  return {
    settings,
    environment,
    root,
    requests,
    requestLog,
    launchLog,
  };
});
