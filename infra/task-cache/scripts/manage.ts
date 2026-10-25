import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Console from "effect/Console";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Flag from "effect/cli/Flag";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";

import * as WriterRegistry from "../src/WriterRegistry.ts";

const decodeDeployment = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ url: Schema.String })),
);

const name = Argument.String("name").pipe(Argument.withDescription("Lowercase writer name"));
const updateWriter = Effect.fn("TaskCache.manageWriter")(function* (
  name: string,
  revoke: boolean,
  initialize = false,
) {
  const registry = yield* WriterRegistry.WriterRegistry;
  let endpoint: string | undefined;
  if (!revoke && WriterRegistry.isWriterName(name)) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const output = yield* spawner.string(
      ChildProcess.make(
        "node",
        [
          `${import.meta.dirname}/../node_modules/alchemy/bin/cli.js`,
          "state",
          "read",
          "T3TaskCache/prod/output",
          "--backend",
          "cloudflare",
          "--no-input",
        ],
        { cwd: `${import.meta.dirname}/..`, stderr: "inherit" },
      ),
    );
    const deployed = yield* decodeDeployment(output);
    endpoint = new URL("/projects/t3code", deployed.url).href;
  }
  const file = yield* registry.update(name, revoke, endpoint, initialize);
  yield* Console.log(
    file === undefined
      ? `Removed ${name} from the local writer registry.`
      : `Private credential written to ${file}.`,
  );
  yield* Console.log(
    "Run alchemy deploy --stage prod from infra/task-cache to apply the writer changes.",
  );
});

const command = Command.make("task-cache").pipe(
  Command.withSubcommands([
    Command.make(
      "add-writer",
      { name, newRegistry: Flag.Boolean("new-registry").pipe(Flag.withDefault(false)) },
      ({ name, newRegistry }) => updateWriter(name, false, newRegistry),
    ),
    Command.make("revoke-writer", { name }, ({ name }) => updateWriter(name, true)),
  ]),
);

Command.run(command, { version: "1.0.0" }).pipe(
  Effect.provide(WriterRegistry.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  NodeRuntime.runMain,
);
