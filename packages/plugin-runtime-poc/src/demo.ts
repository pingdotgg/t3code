import type { PluginDefinition, PluginRuntimeSnapshot } from "./contract.ts";
import { createEffectScopeRuntime } from "./effectScopeRuntime.ts";

const commandLabels = (snapshot: PluginRuntimeSnapshot) =>
  snapshot.contributions.commands?.map((command) => command.label) ?? [];

const database = (version: string): PluginDefinition => ({
  id: "demo.database",
  version,
  provides: { "demo.database@1": { version } },
  activate(context) {
    context.register("status", { id: "database", label: `database ${version}` });
  },
});

const issues: PluginDefinition = {
  id: "demo.issues",
  version: "1.0.0",
  requires: ["demo.database@1"],
  activate(context) {
    const service = context.resolve<{ readonly version: string }>("demo.database@1");
    context.register("commands", {
      id: "create-issue",
      label: `create issue with database ${service.version}`,
    });
  },
};

const chain = (length: number): ReadonlyArray<PluginDefinition> =>
  Array.from({ length }, (_, index) => ({
    id: `benchmark.plugin.${index}`,
    version: "1.0.0",
    ...(index === 0 ? {} : { requires: [`benchmark.capability.${index - 1}`] }),
    provides: { [`benchmark.capability.${index}`]: index },
    activate() {},
  }));

const lifecycle: Array<string> = [];
const runtime = createEffectScopeRuntime({
  onLifecycle: ({ phase, pluginId }) => lifecycle.push(`${phase}:${pluginId}`),
});
const initial = await runtime.reconcile([issues, database("1.0.0")]);
const upgraded = await runtime.reconcile([issues, database("2.0.0")]);
await runtime.reconcile([]);

const benchmark = createEffectScopeRuntime();
const benchmarkDefinitions = chain(250);
const startedAt = process.hrtime.bigint();
await benchmark.reconcile(benchmarkDefinitions);
const activationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
const noopStartedAt = process.hrtime.bigint();
await benchmark.reconcile(benchmarkDefinitions);
const noopMs = Number(process.hrtime.bigint() - noopStartedAt) / 1_000_000;
const upgradedDefinitions = benchmarkDefinitions.map((definition, index) =>
  index === 0 ? { ...definition, version: "2.0.0" } : definition,
);
const restartStartedAt = process.hrtime.bigint();
await benchmark.reconcile(upgradedDefinitions);
const restartMs = Number(process.hrtime.bigint() - restartStartedAt) / 1_000_000;
await benchmark.dispose();

process.stdout.write(
  `${JSON.stringify(
    {
      variant: "effect-scope",
      initialCommands: commandLabels(initial),
      upgradedCommands: commandLabels(upgraded),
      lifecycle,
      chain250ActivationMs: Math.round(activationMs * 100) / 100,
      chain250NoopMs: Math.round(noopMs * 100) / 100,
      chain250RootRestartMs: Math.round(restartMs * 100) / 100,
    },
    null,
    2,
  )}\n`,
);
await runtime.dispose();
