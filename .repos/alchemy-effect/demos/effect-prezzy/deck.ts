import type { DeckItem } from "./shared/types.ts";

/**
 * The presentation, in order. Slides are designed in React
 * (`remotion/slides/`); scenes are real demos recorded by `capture.ts` from
 * `scenes/<id>.ts`, each ending at `chapters/<id>`. Each item becomes one
 * scene in the presenter.
 */
export const deck: DeckItem[] = [
  { kind: "intro", id: "intro" },
  {
    kind: "slide",
    id: "recap",
    title: "Recap",
    notes: "Recap the loop: schema, types, tests, website, production.",
    layout: "bullets",
    props: {
      heading: "What we built",
      bullets: [
        "An HTTP API, defined as a schema",
        "Type-checked, then tested locally, on every change",
        "A website calling it through the same typed client",
        "D1 in dev, Postgres on Neon in production, behind one Layer",
        "Deployed with one command",
      ],
    },
    seconds: 3,
  },
];

/**
 * The second talk: the tightest feedback loop for an agent, built from
 * `intro/loop.ts`. The presenter opens it by default; `?deck=talk` opens `deck`.
 */
export const loopDeck: DeckItem[] = [{ kind: "intro", id: "loop" }];
