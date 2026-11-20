import type { EnvironmentId, LocalApp } from "@t3tools/contracts";

import type { ComposerCommandItem } from "./ComposerCommandMenu";

type ComposerAppItem = Extract<ComposerCommandItem, { type: "app" }>;

const COMPOSER_APP_RESULT_LIMIT = 8;

/**
 * Desktop apps the `@` picker offers so the agent can drive them with computer use. Like
 * machines, they need a query: bare `@` stays a file picker. Name prefixes rank first; within a
 * rank the server's order holds, which puts running apps ahead of installed ones.
 */
export function matchComposerAppItems(input: {
  readonly apps: ReadonlyArray<LocalApp>;
  readonly environmentId: EnvironmentId;
  readonly query: string;
}): ComposerAppItem[] {
  const query = input.query.trim().toLowerCase();
  if (query.length === 0) return [];
  const ranked: Array<{ app: LocalApp; rank: number }> = [];
  for (const app of input.apps) {
    const name = app.name.toLowerCase();
    // Localized names differ from the bundle's file name ("카카오톡" is KakaoTalk.app).
    const fileName = (app.path.split("/").at(-1) ?? "").replace(/\.app$/u, "").toLowerCase();
    const rank =
      name.startsWith(query) || fileName.startsWith(query)
        ? 0
        : name.includes(query) || fileName.includes(query)
          ? 1
          : null;
    if (rank !== null) ranked.push({ app, rank });
  }
  return ranked
    .sort((left, right) => left.rank - right.rank)
    .slice(0, COMPOSER_APP_RESULT_LIMIT)
    .map(({ app }) => ({
      id: `app:${app.path}`,
      type: "app",
      app,
      environmentId: input.environmentId,
      label: app.name,
      description: app.running ? "Running app" : "App",
    }));
}
