import mermaid from "mermaid";

import { card, cssVar, failure, h, onThemeChange, start, t } from "../runtime.ts";

void start<{ readonly title: string; readonly mermaid: string }>((diagram, root) => {
  const canvas = h("div", { class: "diagram" });
  root.append(
    card(diagram.title, [canvas], {
      ask: `${t("About the diagram", "O schemacie")} "${diagram.title}": `,
    }),
  );
  let drawn = 0;
  const draw = async () => {
    const dark = document.documentElement.dataset.theme === "dark";
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      themeVariables: {
        darkMode: dark,
        fontFamily: cssVar("--font-sans") || "system-ui",
        fontSize: "14px",
        background: cssVar("--surface"),
        primaryColor: cssVar("--accent-surface") || (dark ? "#2a2f45" : "#eef0fd"),
        primaryTextColor: cssVar("--text") || (dark ? "#eee" : "#1c1b19"),
        primaryBorderColor: cssVar("--accent") || "#3552d1",
        lineColor: cssVar("--soft") || "#66635c",
        secondaryColor: cssVar("--muted") || "#f5f4f0",
        tertiaryColor: cssVar("--muted") || "#f5f4f0",
      },
    });
    const run = ++drawn;
    try {
      const { svg } = await mermaid.render(`diagram-${run}`, diagram.mermaid);
      if (run === drawn) canvas.innerHTML = svg;
    } catch (error) {
      if (run === drawn) {
        canvas.replaceChildren(failure(error), h("pre", { class: "soft" }, diagram.mermaid));
      }
    }
  };
  void draw();
  onThemeChange(() => void draw());
});
