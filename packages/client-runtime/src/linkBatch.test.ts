import { EnvironmentId, PeerLinkError } from "@t3tools/contracts";
import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import { linkBatchCandidates, linkBatchSummary, linkListState, runLinkBatch } from "./linkBatch.ts";
import type { LinkableMachine } from "./linkRequest.ts";

const machine = (name: string, overrides: Partial<LinkableMachine> = {}): LinkableMachine => ({
  environmentId: EnvironmentId.make(`environment-${name}`),
  label: name,
  machine: "server",
  connected: true,
  connectOnly: false,
  linked: false,
  urls: [`https://${name}.example.ts.net`, `http://100.64.0.1:3773`],
  ...overrides,
});
const id = (name: string) => EnvironmentId.make(`environment-${name}`);

describe("linkBatchCandidates", () => {
  it("offers only machines the client can mint a code on and has an address for", () => {
    const machines = [
      machine("ready"),
      machine("linked", { linked: true, connected: false }),
      machine("offline", { connected: false }),
      machine("connect", { connected: false, connectOnly: true }),
      machine("viewer"),
      machine("loopback", { urls: [] }),
    ];
    const writable = new Set([id("ready"), id("linked"), id("offline"), id("loopback")]);
    expect(
      linkBatchCandidates(machines, writable, "loaded").map(({ machine, blocked }) => [
        machine.label,
        blocked,
      ]),
    ).toEqual([
      ["ready", null],
      ["linked", "linked"],
      ["offline", "not_connected"],
      ["connect", "not_connected"],
      ["viewer", "no_access"],
      ["loopback", "no_address"],
    ]);
  });

  it("offers no machine until the linking environment's links have loaded", () => {
    // With no list, a linked machine reads as unlinked.
    const machines = [machine("ready"), machine("linked-but-unlisted")];
    const writable = new Set(machines.map((entry) => entry.environmentId));
    const blockedWhen = (query: Parameters<typeof linkListState>[0]) =>
      linkBatchCandidates(machines, writable, linkListState(query)).map(({ blocked }) => blocked);
    expect(linkListState({ data: null, error: null })).toBe("loading");
    expect(linkListState({ data: null, error: "The environment request failed." })).toBe("failed");
    expect(blockedWhen({ data: null, error: null })).toEqual(["links_unknown", "links_unknown"]);
    expect(blockedWhen({ data: null, error: "failed" })).toEqual([
      "links_unknown",
      "links_unknown",
    ]);
    expect(blockedWhen({ data: { links: [] }, error: null })).toEqual([null, null]);
  });
});

describe("runLinkBatch", () => {
  it("links each machine with its own code, reports each failure, and retries only those", async () => {
    const machines = ["a", "b", "c", "d", "e"].map((name) => machine(name));
    const linked: Array<unknown> = [];
    const failures: Record<string, unknown> = {
      b: new PeerLinkError({
        reason: "pairing_rejected",
        message: "The peer refused the sign-in.",
      }),
      c: new PeerLinkError({ reason: "unreachable", message: "c did not answer." }),
      d: new PeerLinkError({
        reason: "unreachable",
        message: "d answered as another environment, Impostor.",
        answeredAs: "Impostor",
      }),
    };
    const seen: Array<string> = [];
    const outcomes = await runLinkBatch({
      machines,
      access: "auto",
      mint: async (environmentId) =>
        environmentId === id("e")
          ? Result.fail(new Error("no session"))
          : Result.succeed(`code-for-${environmentId}`),
      link: async (input) => {
        linked.push(input);
        const failure = failures[input.expectedLabel ?? ""];
        return failure === undefined ? Result.succeed(null) : Result.fail(failure);
      },
      refreshLinks: () => {},
      onOutcome: (environmentId) => seen.push(environmentId),
    });

    expect(linked[0]).toEqual({
      url: "https://a.example.ts.net",
      alternateUrls: ["http://100.64.0.1:3773"],
      expectedEnvironmentId: id("a"),
      expectedLabel: "a",
      pairingCode: `code-for-${id("a")}`,
      access: "auto",
    });
    // A machine with no code is never linked.
    expect(linked.length).toBe(4);
    expect(Object.fromEntries(outcomes)).toEqual({
      [id("a")]: { kind: "linked" },
      [id("b")]: {
        kind: "failed",
        failure: "code_refused",
        detail: "The peer refused the sign-in.",
      },
      [id("c")]: { kind: "failed", failure: "unreachable", detail: "c did not answer." },
      [id("d")]: {
        kind: "failed",
        failure: "wrong_environment",
        detail: "d answered as another environment, Impostor.",
      },
      [id("e")]: { kind: "failed", failure: "no_code", detail: null },
    });
    expect(seen.toSorted()).toEqual(machines.map((entry) => entry.environmentId));
    expect(linkBatchSummary(outcomes)).toEqual({
      linked: 1,
      failed: [id("b"), id("c"), id("d"), id("e")],
    });
  });

  it("never shows a failure that may carry the request and its pairing code", async () => {
    const outcomes = await runLinkBatch({
      machines: [machine("a")],
      access: "auto",
      mint: async () => Result.succeed("secret-code"),
      link: async (input) => Result.fail(new Error(`request failed: ${JSON.stringify(input)}`)),
      refreshLinks: () => {},
    });
    expect(outcomes.get(id("a"))).toEqual({ kind: "failed", failure: "other", detail: null });
  });

  it("opens at most four pairings at once", async () => {
    let open = 0;
    let most = 0;
    await runLinkBatch({
      machines: Array.from({ length: 10 }, (_, index) => machine(`vm-${index}`)),
      access: "auto",
      mint: async () => {
        open += 1;
        most = Math.max(most, open);
        return Result.succeed("code");
      },
      link: async () => {
        await Promise.resolve();
        open -= 1;
        return Result.succeed(null);
      },
      refreshLinks: () => {},
    });
    expect(most).toBe(4);
  });

  it("refreshes the links list once for the whole batch, after its last link", async () => {
    const events: Array<string> = [];
    const run = (names: ReadonlyArray<string>, fails: boolean) =>
      runLinkBatch({
        machines: names.map((name) => machine(name)),
        access: "auto",
        mint: async () => Result.succeed("code"),
        link: async () => {
          await Promise.resolve();
          events.push("link");
          return fails ? Result.fail(new Error("refused")) : Result.succeed(null);
        },
        refreshLinks: () => events.push("refresh"),
      });
    const names = Array.from({ length: 12 }, (_, index) => `vm-${index}`);
    await run(names, false);
    expect(events).toEqual([...names.map(() => "link"), "refresh"]);
    // A retry batch is one more refresh; a batch that linked nothing changed no list.
    await run(names.slice(0, 3), false);
    await run(names.slice(0, 3), true);
    expect(events.filter((event) => event === "refresh").length).toBe(2);
  });
});
