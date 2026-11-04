import { defineScene } from "../capture/scene.ts";

export default defineScene({
  title: "A dashboard as code",
  chapter: "08-dashboard",
  notes:
    "An Axiom.Dashboard declared next to the code it observes: requests by route, p95 latency, clicks by link, errors. Every stage gets its own dashboard over its own datasets, and a chart change is a reviewable diff.",
  async run(s) {
    await s.sync({ except: ["src/Dashboard.ts", "alchemy.run.ts"] });
    await s.editor.show("src/Dashboard.ts");
    s.pause(1);
    await s.editor.show("alchemy.run.ts");
    s.pause(1);

    await s.terminal(async (t) => {
      await t.waitDev({ timeout: 240_000 });
      await t.sleep(800);
      await t.run(
        "deploy",
        `for i in $(seq 5); do curl -s -o /dev/null localhost:1337/$CODE; done`,
      );
    });

    await s.diagram({
      stage: `dev_${process.env.USER}`,
      nodes: ["Dashboard"],
      edges: ["Dashboard->Traces"],
    });
    s.pause(1.5);

    await s.terminal(async (t) => {
      await t.run("test", "pnpm test", {
        until: /Ran \d+ tests? across[\s\S]*❯\s*$/,
        timeout: 300_000,
      });
      await t.sleep(1500);
    });
  },
});
