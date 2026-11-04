import { defineScene } from "../capture/scene.ts";

export default defineScene({
  title: "Ship it",
  chapter: "08-dashboard",
  notes:
    "The service is built and tested. Now, and only now, deploy it: one command stands up the whole architecture as a new stage.",
  async run(s) {
    s.step(
      "Deploy to production with alchemy deploy",
      "Everything so far ran under alchemy dev and in throwaway test stages. alchemy deploy --stage prod plans the whole Stack for a new stage, asks to confirm, and applies it.",
    );
    const url = await s.terminal(async (t) => {
      await t.type("deploy", "alchemy deploy --stage prod");
      await t.waitFor("deploy", /Deploy\?/, { timeout: 180_000 });
      await t.sleep(1500);
      await t.key("deploy", "Enter");
      const text = await t.waitFor("deploy", /Stack deployed[\s\S]*❯\s*$/, { timeout: 600_000 });
      await t.sleep(1500);
      const found = text.match(/https:\/\/shorty-web-[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/)?.[0];
      if (!found) throw new Error("deployed web URL not found in the terminal output");
      return found;
    });

    s.step(
      "The same architecture, now in the cloud",
      "Every resource from the talk, now really deployed to the prod stage.",
    );
    await s.diagram({
      stage: "prod",
      nodes: ["Web", "Api", "LinkRoom", "Clicks", "Postgres", "Dashboard"],
    });
    s.pause(1.5);

    s.step("Shorty is live");
    await s.browser.open(url, { waitFor: /Your links/ });
    s.pause(0.5);
    s.step("Shorten a link in production");
    await s.browser.fill("form input", "https://alchemy.run");
    await s.browser.click("form button", { waitFor: /alchemy\.run/ });
    s.pause(1.5);
  },
});
