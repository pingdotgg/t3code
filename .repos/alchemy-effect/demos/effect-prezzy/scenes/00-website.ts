import { defineScene, edit } from "../capture/scene.ts";

export default defineScene({
  title: "A Stack and a website",
  chapter: "00-website",
  notes: "Chapter 0: declare a Stack with one Vite website and run it locally with alchemy dev.",
  async run(s) {
    await s.sync({ except: ["alchemy.run.ts"] });

    s.step(
      "Start from a plain Vite + React app",
      "An ordinary Vite + React dashboard. Nothing Alchemy-specific in it yet.",
    );
    await s.editor.open("src/main.tsx");
    s.pause(1);

    const stack = await s.chapterLines("alchemy.run.ts");
    await s.editor.patch(
      "alchemy.run.ts",
      "Create alchemy.run.ts",
      edit.set(stack(1, 3)),
      "alchemy.run.ts is the whole infrastructure program. It's plain TypeScript: Alchemy, the Cloudflare provider, and Effect.",
    );
    await s.editor.patch(
      "alchemy.run.ts",
      "Declare the Stack",
      edit.append(`\n${stack(5, 11)}  }),\n);\n`),
      "A Stack has a name, the providers it can use, and where it keeps its state. Its body is an Effect: every resource is something we yield.",
    );
    await s.editor.patch(
      "alchemy.run.ts",
      "Add the Vite website as a resource",
      edit.after(stack(11), stack(12, 14)),
      "Cloudflare.Website.Vite builds the Vite app and serves it from a Cloudflare Worker. dev pins the port alchemy dev serves it on.",
    );
    await s.editor.patch(
      "alchemy.run.ts",
      "Output the website's URL",
      edit.after(stack(14), stack(15, 16)),
      "Whatever the Stack returns is its output: printed by alchemy dev and after every deploy.",
    );

    s.step(
      "Run the Stack locally with alchemy dev",
      "alchemy dev runs the whole Stack on this machine and hot-reloads it on every save. It stays up in its own tab while we build; nothing is deployed until the end.",
    );
    await s.terminal(async (t) => {
      await t.type("dev", "alchemy dev");
      await t.waitDev();
      await t.sleep(1000);
    });

    s.step(
      "One resource, running locally",
      "The architecture so far: a single website, running in alchemy dev's local simulator.",
    );
    await s.diagram({ stage: `dev_${process.env.USER}`, nodes: ["Web"] });
    s.pause(1);

    s.step("The website, served by alchemy dev");
    await s.browser.open("http://localhost:5173", { waitFor: /Your links/ });
    s.pause(1.5);
  },
});
