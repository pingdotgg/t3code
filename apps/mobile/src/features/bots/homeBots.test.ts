import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";
import { buildHomeBots } from "./homeBots";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const botConfig = { enabled: true, muteChildren: false } as const;

const threads = [
  makeThreadShellFixture({ environmentId: local, id: ThreadId.make("plain"), title: "Plain" }),
  makeThreadShellFixture({
    environmentId: local,
    id: ThreadId.make("bot"),
    title: "Triage",
    botConfig,
    createdAt: "2026-06-01T00:00:00.000Z",
  }),
  makeThreadShellFixture({
    environmentId: local,
    id: ThreadId.make("worker"),
    title: "Worker",
    groupedUnderThreadId: ThreadId.make("bot"),
    hasPendingApprovals: true,
  }),
  makeThreadShellFixture({
    environmentId: remote,
    id: ThreadId.make("remote-bot"),
    title: "Remote",
    botConfig,
    createdAt: "2026-06-02T00:00:00.000Z",
  }),
];

describe("buildHomeBots", () => {
  it("lists Bots as their own rows and keeps them and their workers out of the thread list", () => {
    const home = buildHomeBots({ threads, environmentId: null, searching: false });

    expect(home.rows.map((row) => row.bot.title)).toEqual(["Triage", "Remote"]);
    expect(home.rows[0]?.status).toMatchObject({ state: "waiting", needsYou: 1 });
    expect(home.rows[0]?.memberKeys).toEqual(["local:bot", "local:worker"]);
    expect(home.listedThreads.map((thread) => thread.title)).toEqual(["Plain"]);
  });

  it("follows the machine filter, and a search lists every thread instead", () => {
    expect(
      buildHomeBots({ threads, environmentId: remote, searching: false }).rows.map(
        (row) => row.bot.title,
      ),
    ).toEqual(["Remote"]);

    const searching = buildHomeBots({ threads, environmentId: null, searching: true });
    expect(searching.rows).toEqual([]);
    expect(searching.listedThreads).toBe(threads);
  });
});
