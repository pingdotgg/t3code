// Registers one handler under each `t3.` namespace so PluginSupervisor.test.ts
// can check which ones the child runtime reserves.
export function activate(context) {
  const refusals = {};
  for (const name of [
    "t3.tool.echo",
    "t3.transform.enrich",
    "t3.transform.other",
    "t3.approval.decide",
    "t3.approval.other",
    "t3.events",
    "t3.other",
  ]) {
    try {
      context.proposed.handle(name, (input) => ({ handler: name, input }));
    } catch (error) {
      refusals[name] = error.message;
    }
  }
  context.proposed.handle("refusals", () => refusals);
}
