import { defineScene } from "../capture/scene.ts";

export default defineScene({
  title: "Durable Objects and hibernatable WebSockets",
  chapter: "04-durable-objects",
  notes:
    "One LinkRoom Durable Object per link keeps the click count in transactional storage. The Worker calls it with typed RPC (record), and hands WebSocket upgrades to it; the sockets are hibernatable, so idle rooms can be evicted while connections stay open. The dashboard shows each count live, and a new test opens a socket, clicks, and expects the push.",
  async run(s) {
    await s.sync({ except: ["src/LinkRoom.ts", "src/Api.ts", "src/main.tsx", "test/api.test.ts"] });
    await s.editor.show("src/LinkRoom.ts");
    s.pause(1);
    await s.editor.show("src/Api.ts");
    s.pause(0.5);
    await s.editor.show("src/main.tsx");
    s.pause(1);

    await s.terminal(async (t) => {
      await t.waitDev();
      await t.sleep(800);
      await t.run("deploy", `for i in 1 2 3; do curl -s -o /dev/null localhost:1337/$CODE; done`);
    });

    await s.browser.open("http://localhost:5173", { waitFor: /alchemy\.run\s+\/\w+\s+3\b/ });
    s.pause(1.5);
    await s.diagram({
      stage: `dev_${process.env.USER}`,
      nodes: ["LinkRoom"],
      edges: ["Api->LinkRoom"],
    });
    s.pause(1);

    await s.editor.show("test/api.test.ts");
    s.pause(0.5);
    await s.terminal(async (t) => {
      await t.run("test", "pnpm test", {
        until: /Ran \d+ tests? across[\s\S]*❯\s*$/,
        timeout: 300_000,
      });
      await t.sleep(1500);
    });
  },
});
