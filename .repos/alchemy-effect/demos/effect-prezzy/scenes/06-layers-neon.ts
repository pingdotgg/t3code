import { defineScene } from "../capture/scene.ts";

export default defineScene({
  title: "Storage as a Layer, with Neon",
  chapter: "06-layers-neon",
  notes:
    "Links is a service contract; LinksSql implements it over Effect's generic SqlClient. Each storage Layer owns its infrastructure: D1Storage declares the D1 database, NeonStorage declares a Neon Postgres project behind Hyperdrive, with the same migrations. Swapping is one Effect.provide line. Neon has no emulator, so alchemy dev creates a real Neon project in the dev stage next to the local Worker. The tests pass unchanged apart from the provider list.",
  async run(s) {
    await s.sync({
      except: [
        "src/Links.ts",
        "src/Storage.ts",
        "src/Api.ts",
        "alchemy.run.ts",
        "test/api.test.ts",
        "src/Db.ts",
      ],
    });
    await s.editor.show("src/Links.ts");
    s.pause(1);
    await s.editor.show("src/Storage.ts");
    s.pause(1);
    await s.editor.show("src/Api.ts");
    s.pause(0.5);
    await s.editor.remove("src/Db.ts");
    await s.editor.show("alchemy.run.ts");
    s.pause(1);

    await s.terminal(async (t) => {
      await t.waitDev({ timeout: 240_000 });
      await t.sleep(800);
      await t.run(
        "deploy",
        `CODE=$(curl -s --json '{"url":"https://neon.com"}' localhost:1337/links | jq -r .code)`,
      );
      await t.run("deploy", "curl localhost:1337/links");
    });

    await s.browser.open("http://localhost:5173", { waitFor: /neon\.com/ });
    s.pause(1.5);
    await s.diagram({
      stage: `dev_${process.env.USER}`,
      nodes: ["Postgres", "Pool"],
      edges: ["Api->Pool", "Pool->Postgres"],
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
