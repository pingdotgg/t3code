import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

import type { GitHubEventHub as GitHubEventHubClass } from "./src/worker.ts";

export const GitHubEventHub = Cloudflare.DurableObject<GitHubEventHubClass>("GitHubEventHub", {
  className: "GitHubEventHub",
});

export const Worker = Cloudflare.Worker("GitHubEvents", {
  main: "./src/worker.ts",
  compatibility: {
    date: "2026-06-04",
  },
  env: {
    GITHUB_EVENT_HUB: GitHubEventHub,
    GITHUB_EVENTS_FEED_TOKEN: Config.redacted("GITHUB_EVENTS_FEED_TOKEN"),
    GITHUB_REPOSITORY: Config.string("GITHUB_REPOSITORY").pipe(
      Config.withDefault("pingdotgg/t3code"),
    ),
    GITHUB_WEBHOOK_SECRET: Config.redacted("GITHUB_WEBHOOK_SECRET"),
  },
});

export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;

export default Alchemy.Stack(
  "T3CodeGitHubEvents",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* Worker;
    return {
      url: worker.url.as<string>(),
      workerName: worker.workerName,
    };
  }),
);
