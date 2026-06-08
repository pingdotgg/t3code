import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { Command, Flag } from "effect/unstable/cli";

import {
  InstanceRegistry,
  layer as instanceRegistryLayer,
  type InstanceRecord,
} from "../instances/InstanceRegistry.ts";

const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const padEnd = (value: string, width: number): string =>
  value.length >= width ? value : value + " ".repeat(width - value.length);

const formatInstancesTable = (instances: ReadonlyArray<InstanceRecord>): string => {
  const header = ["ID", "NAME", "PID", "ADDRESS", "BASE DIR", "CWD"] as const;
  const rows = instances.map((instance) => [
    instance.instanceId,
    instance.name ?? "-",
    String(instance.pid),
    `${instance.host}:${instance.port}`,
    instance.baseDir,
    instance.cwd,
  ]);

  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...rows.map((row) => (row[column] ?? "").length)),
  );

  const renderRow = (cells: ReadonlyArray<string>): string =>
    cells
      .map((cell, column) => padEnd(cell, widths[column] ?? cell.length))
      .join("  ")
      .trimEnd();

  return [renderRow(header), ...rows.map(renderRow)].join("\n");
};

/**
 * `t3 instances` — list live T3 server instances registered on this machine.
 */
export const instancesCommand = Command.make("instances", { json: jsonFlag }).pipe(
  Command.withDescription("List live T3 Code instances running on this machine."),
  Command.withHandler(({ json }) =>
    Effect.gen(function* () {
      const registry = yield* InstanceRegistry;
      const instances = yield* registry.list();

      if (json) {
        // @effect-diagnostics-next-line preferSchemaOverJson:off - CLI JSON output is a presentation DTO.
        yield* Console.log(JSON.stringify(instances, null, 2));
        return;
      }

      if (instances.length === 0) {
        yield* Console.log("No live T3 Code instances found.");
        return;
      }

      yield* Console.log(formatInstancesTable(instances));
    }).pipe(Effect.provide(instanceRegistryLayer)),
  ),
);
