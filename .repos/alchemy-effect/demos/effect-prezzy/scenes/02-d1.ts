import { defineScene } from "../capture/scene.ts";

export default defineScene({
  title: "Store links in D1",
  chapter: "02-d1",
  notes:
    "A D1 database with a migrations folder. yield* Cloudflare.D1.QueryDatabase(Db) is the binding: it grants this one database to this one Worker, with no account token shipped. Effect SQL on top. alchemy dev applied the migration to the local D1, and short links now redirect.",
  async run(s) {
    await s.sync({ except: ["migrations/0001_links.sql", "src/Db.ts", "src/Api.ts"] });
    await s.editor.show("migrations/0001_links.sql");
    s.pause(0.5);
    await s.editor.show("src/Db.ts");
    s.pause(0.5);
    await s.editor.show("src/Api.ts");
    s.pause(1);

    await s.terminal(async (t) => {
      await t.waitDev();
      await t.sleep(800);
      await t.run(
        "deploy",
        `CODE=$(curl -s --json '{"url":"https://alchemy.run"}' localhost:1337/links | jq -r .code)`,
      );
      await t.run(
        "deploy",
        `curl -s -o /dev/null -w '%{http_code} → %{redirect_url}\\n' localhost:1337/$CODE`,
      );
    });

    await s.diagram({ stage: `dev_${process.env.USER}`, nodes: ["Db"], edges: ["Api->Db"] });
    s.pause(1);
    await s.browser.open("http://localhost:5173", { waitFor: /alchemy\.run/ });
    s.pause(1.5);
  },
});
