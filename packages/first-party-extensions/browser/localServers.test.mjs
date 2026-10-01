import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import {
  LOCAL_SERVERS_CLOSED_MESSAGE,
  LOCAL_SERVERS_TRUNCATED_NOTICE,
  NO_PREVIEW_DESCRIPTION,
  NO_PREVIEW_DESCRIPTION_WITHOUT_DISCOVERY,
  NO_PREVIEW_TITLE,
  landingModel,
  localServersErrorState,
  localServersFromSnapshot,
  watchLocalServers,
} from "./localServers.ts";

const snapshot = (servers, truncated = false) => ({
  kind: "snapshot",
  scope: "environment",
  servers,
  truncated,
});

NodeTest.describe("localServersFromSnapshot", () => {
  NodeTest.it("sorts by port and renders the native unenriched card copy", () => {
    const state = localServersFromSnapshot(
      snapshot([
        { url: "http://localhost:5173/", port: 5173 },
        { url: "http://localhost:3000/", port: 3000 },
        { url: "http://127.0.0.1:8080/", port: 8080 },
      ]),
    );
    NodeAssert.equal(state.kind, "ready");
    NodeAssert.equal(state.truncated, false);
    NodeAssert.deepEqual(
      state.servers.map((server) => [server.url, server.title, server.description]),
      [
        ["http://localhost:3000/", "Listening", "localhost:3000"],
        ["http://localhost:5173/", "Listening", "localhost:5173"],
        ["http://127.0.0.1:8080/", "Listening", "127.0.0.1:8080"],
      ],
    );
  });

  NodeTest.it("folds loopback aliases on one port into a single localhost row", () => {
    const state = localServersFromSnapshot(
      snapshot([
        { url: "http://127.0.0.1:4000/", port: 4000 },
        { url: "http://[::1]:4000/", port: 4000 },
        { url: "http://localhost:4000/", port: 4000 },
      ]),
    );
    NodeAssert.deepEqual(
      state.servers.map((server) => server.url),
      ["http://localhost:4000/"],
    );
  });

  NodeTest.it("keeps different ports and schemes apart", () => {
    const state = localServersFromSnapshot(
      snapshot([
        { url: "https://localhost:8443/", port: 8443 },
        { url: "http://localhost:8080/", port: 8080 },
      ]),
    );
    NodeAssert.equal(state.servers.length, 2);
  });

  NodeTest.it("carries truncated through and marks it when an entry is unusable", () => {
    NodeAssert.equal(localServersFromSnapshot(snapshot([], true)).truncated, true);
    const dropped = localServersFromSnapshot(
      snapshot([
        { url: "ftp://localhost:21/", port: 21 },
        { url: "not a url", port: 1 },
        { url: "http://localhost:3000/", port: 3000 },
      ]),
    );
    NodeAssert.equal(dropped.truncated, true);
    NodeAssert.deepEqual(
      dropped.servers.map((server) => server.port),
      [3000],
    );
  });
});

NodeTest.describe("localServersErrorState", () => {
  NodeTest.it("names the missing read grant", () => {
    const state = localServersErrorState(
      new Error("API capability denied: t3.browser/read-local-servers"),
    );
    NodeAssert.equal(state.kind, "denied");
    NodeAssert.equal(state.grant, "t3.browser/read-local-servers");
    NodeAssert.match(state.message, /t3\.browser\/read-local-servers/);
  });

  NodeTest.it("reports anything else with its detail", () => {
    const state = localServersErrorState(new Error("API unavailable"));
    NodeAssert.equal(state.kind, "unavailable");
    NodeAssert.match(state.message, /API unavailable/);
  });
});

const streamOf = (frames, { fail } = {}) => ({
  subscribe(name, input, signal) {
    NodeAssert.equal(name, "subscribe");
    NodeAssert.deepEqual(input, {});
    NodeAssert.ok(signal instanceof AbortSignal);
    return (async function* () {
      for (const frame of frames) yield frame;
      if (fail) throw fail;
    })();
  },
});

NodeTest.describe("watchLocalServers", () => {
  NodeTest.it("reports loading, then each snapshot", async () => {
    const states = [];
    await watchLocalServers(
      streamOf([
        { value: snapshot([{ url: "http://localhost:3000/", port: 3000 }]) },
        { value: snapshot([]) },
      ]),
      new AbortController().signal,
      (state) => states.push(state),
    );
    NodeAssert.deepEqual(
      states.map((state) => [state.kind, state.servers?.length]),
      [
        ["loading", undefined],
        ["ready", 1],
        ["ready", 0],
        ["unavailable", undefined],
      ],
    );
  });

  NodeTest.it("names closed: source-unavailable instead of an empty list", async () => {
    const states = [];
    await watchLocalServers(
      streamOf([
        { value: snapshot([{ url: "http://localhost:3000/", port: 3000 }]) },
        { value: { kind: "closed", reason: "source-unavailable" } },
        { value: snapshot([]) },
      ]),
      new AbortController().signal,
      (state) => states.push(state),
    );
    NodeAssert.deepEqual(states.at(-1), { kind: "closed", message: LOCAL_SERVERS_CLOSED_MESSAGE });
    NodeAssert.equal(states.length, 3, "nothing after closed");
  });

  NodeTest.it("maps a denied subscribe to the grant-denied model", async () => {
    const states = [];
    await watchLocalServers(
      streamOf([], { fail: new Error("API capability denied: t3.browser/read-local-servers") }),
      new AbortController().signal,
      (state) => states.push(state),
    );
    NodeAssert.equal(states.at(-1).kind, "denied");
  });

  NodeTest.it("reports nothing once aborted", async () => {
    const controller = new AbortController();
    const states = [];
    await watchLocalServers(
      {
        subscribe: () =>
          (async function* () {
            controller.abort();
            yield { value: snapshot([{ url: "http://localhost:3000/", port: 3000 }]) };
            throw new Error("aborted");
          })(),
      },
      controller.signal,
      (state) => states.push(state),
    );
    NodeAssert.deepEqual(
      states.map((state) => state.kind),
      ["loading"],
    );
  });
});

NodeTest.describe("landingModel", () => {
  const ready = (servers, truncated = false) => ({ kind: "ready", servers, truncated });
  const row = { url: "http://localhost:3000/", host: "localhost", port: 3000 };

  NodeTest.it("shows the native No preview copy only when both lists are empty", () => {
    NodeAssert.deepEqual(landingModel({ recentCount: 0, localServers: ready([]) }).noPreview, {
      title: NO_PREVIEW_TITLE,
      description: NO_PREVIEW_DESCRIPTION,
    });
    NodeAssert.equal(landingModel({ recentCount: 2, localServers: ready([]) }).noPreview, null);
    NodeAssert.equal(landingModel({ recentCount: 0, localServers: ready([row]) }).noPreview, null);
  });

  NodeTest.it("says so when the list is truncated", () => {
    NodeAssert.equal(
      landingModel({ recentCount: 0, localServers: ready([row], true) }).localNotice,
      LOCAL_SERVERS_TRUNCATED_NOTICE,
    );
  });

  NodeTest.it("grant denied: no list, a named reason, recents unaffected", () => {
    const denied = localServersErrorState(new Error("API capability denied: x"));
    const withRecents = landingModel({ recentCount: 3, localServers: denied });
    NodeAssert.deepEqual(withRecents.serverList, []);
    NodeAssert.equal(withRecents.localNotice, denied.message);
    NodeAssert.equal(withRecents.noPreview, null);
    const alone = landingModel({ recentCount: 0, localServers: denied });
    NodeAssert.equal(alone.noPreview.description, NO_PREVIEW_DESCRIPTION_WITHOUT_DISCOVERY);
  });

  NodeTest.it("closed and loading states", () => {
    const closed = landingModel({
      recentCount: 0,
      localServers: { kind: "closed", message: LOCAL_SERVERS_CLOSED_MESSAGE },
    });
    NodeAssert.equal(closed.localNotice, LOCAL_SERVERS_CLOSED_MESSAGE);
    const loading = landingModel({ recentCount: 0, localServers: { kind: "loading" } });
    NodeAssert.equal(loading.localNotice, null);
    NodeAssert.equal(loading.noPreview.description, NO_PREVIEW_DESCRIPTION);
  });
});
