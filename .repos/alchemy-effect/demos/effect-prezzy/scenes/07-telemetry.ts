import { defineScene } from "../capture/scene.ts";

export default defineScene({
  title: "OpenTelemetry to Axiom",
  chapter: "07-telemetry",
  notes:
    "Axiom datasets for traces and logs and an ingest token that can write to those two datasets and nothing else, all named after the stage. Axiom.Telemetry is a Layer: providing it is the whole wiring. Spans come from code that is already Effect: links.create, links.get, clicks.record, plus the HTTP server and SQL spans.",
  async run(s) {
    await s.sync({
      except: ["src/Observability.ts", "src/Api.ts", "src/Links.ts", "alchemy.run.ts"],
    });
    await s.editor.show("src/Observability.ts");
    s.pause(1);
    await s.editor.show("src/Api.ts");
    s.pause(0.5);
    await s.editor.show("src/Links.ts");
    s.pause(0.5);
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
      nodes: ["Traces", "Logs", "Ingest"],
    });
    s.pause(1);

    await s.terminal(async (t) => {
      await t.run("test", "pnpm test", {
        until: /Ran \d+ tests? across[\s\S]*❯\s*$/,
        timeout: 300_000,
      });
      await t.sleep(1500);
    });
  },
});
