import { defineScene } from "../capture/scene.ts";

export default defineScene({
  title: "Test it against the real cloud",
  chapter: "03-tests",
  notes:
    "Test.make + beforeAll(deploy(Stack)) deploys a full copy of the stack to its own stage, test_$USER, on real Cloudflare. The tests use the same typed client as the dashboard, including a typed LinkNotFound across HTTP. afterAll(destroy(Stack)) tears it down. alchemy dev is for trying it; pnpm test proves it on real infrastructure.",
  async run(s) {
    await s.sync({ except: ["test/api.test.ts"] });
    await s.editor.show("test/api.test.ts");
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
