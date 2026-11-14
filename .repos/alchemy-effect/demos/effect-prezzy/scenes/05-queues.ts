import { defineScene } from "../capture/scene.ts";

export default defineScene({
  title: "A Queue, so redirects stay fast",
  chapter: "05-queues",
  notes:
    "The redirect now sends a click event to the Clicks queue and returns immediately. consumeQueueMessages receives each batch as an Effect Stream; we fold it into one count per link and call each LinkRoom once per batch. Producer binding plus a Consumer resource: a cycle (Api → Clicks → Api) that Alchemy resolves. retryDelay covers batches delivered while a fresh deploy is still rolling out.",
  async run(s) {
    await s.sync({ except: ["src/Clicks.ts", "src/Api.ts"] });
    await s.editor.show("src/Clicks.ts");
    s.pause(0.5);
    await s.editor.show("src/Api.ts");
    s.pause(1);

    await s.terminal(async (t) => {
      await t.waitDev();
      await t.sleep(800);
      await t.run(
        "deploy",
        `for i in $(seq 10); do curl -s -o /dev/null localhost:1337/$CODE; done`,
      );
    });

    await s.browser.open("http://localhost:5173", { waitFor: /alchemy\.run\s+\/\w+\s+1\d\b/ });
    s.pause(1.5);
    await s.diagram({
      stage: `dev_${process.env.USER}`,
      nodes: ["Clicks"],
      edges: ["Api->Clicks", "Clicks->Api"],
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
