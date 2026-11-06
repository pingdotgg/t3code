import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Host from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Cli from "./TangledCli.ts";
import * as Provider from "./TangledPullRequestProvider.ts";
import { ChildProcessSpawner } from "effect/process";

it.effect.each([
  "Error: failed to refresh OAuth tokens: token refresh failed: invalid_grant",
  'Error: OAuth permissions changed; signed out alice.example; run "tg auth login alice.example" again',
])("preserves authentication failures: %s", (stderr) => {
  const host = Host.layer({
    process: {
      run: () =>
        Effect.succeed(
          Host.processOutput("", {
            exitCode: ChildProcessSpawner.ExitCode(1),
            stderr,
          }),
        ),
    },
  });
  const client = HttpClient.make(() => Effect.die("No HTTP request is expected"));
  return Effect.gen(function* () {
    const provider = yield* Provider.make;
    const error = yield* provider
      .getViewer({ cwd: "/repo", host: "tangled.org" })
      .pipe(Effect.flip);
    assert.strictEqual(error.reason, "unauthenticated");
    assert.match(error.detail, /tg auth login/u);
  }).pipe(
    Effect.provide(Cli.layer.pipe(Layer.provideMerge(host))),
    Effect.provideService(HttpClient.HttpClient, client),
  );
});

it.effect("uses numeric ticket keys for PR numbers without reading the web page", () => {
  const older = {
    rkey: "9",
    uri: "at://did:plc:repo/org.tangled.track.ticket/9",
    title: "Same title",
    state: "open",
    createdAt: "2026-10-12T12:00:00Z",
    sourceBranch: "old",
    targetBranch: "main",
  };
  const newest = {
    ...older,
    rkey: "11",
    uri: "at://did:plc:repo/org.tangled.track.ticket/11",
    state: "closed",
    commentCount: 2,
  };
  const host = Host.layer({
    process: {
      run: (input) => {
        if (input.args[1] === "list")
          return Effect.succeed(Host.processOutput(JSON.stringify({ items: [newest, older] })));
        if (input.args[1] === "view" && input.args[2] === "11")
          return Effect.succeed(
            Host.processOutput(JSON.stringify({ ...newest, body: "Actual PR description" })),
          );
        return Effect.die("Unexpected tg command");
      },
    },
  });
  const client = HttpClient.make(() => Effect.die("Ticket numbers require no HTML lookup"));
  return Effect.gen(function* () {
    const provider = yield* Provider.make;
    const reference = {
      cwd: "/repo",
      host: "tangled.org",
      repository: "alice.example/repo",
      number: 11,
    };
    const list = yield* provider.listChangeRequests({
      ...reference,
      state: "all",
      involvement: "all",
      viewer: "alice.example",
      limit: 10,
    });
    assert.deepStrictEqual(
      list.items.map((pull) => [pull.number, pull.url]),
      [
        [9, "https://tangled.org/alice.example/repo/pulls/9"],
        [11, "https://tangled.org/alice.example/repo/pulls/11"],
      ],
    );
    const detail = yield* provider.getChangeRequest(reference);
    assert.strictEqual(detail.body, "Actual PR description");
    assert.strictEqual(detail.number, 11);
    assert.strictEqual(detail.state, "closed");
  }).pipe(
    Effect.provide(Cli.layer.pipe(Layer.provideMerge(host))),
    Effect.provideService(HttpClient.HttpClient, client),
  );
});

it.effect("reads a closed PR's activity and details through its list number and record key", () => {
  const calls: Array<ReadonlyArray<string>> = [];
  const older = {
    rkey: "a",
    title: "Still open",
    state: "open",
    createdAt: "2026-10-12T12:00:00Z",
    sourceBranch: "old",
    targetBranch: "main",
  };
  const newest = {
    ...older,
    rkey: "b",
    title: "Closed newest PR",
    state: "closed",
    sourceBranch: "current",
    commentCount: 2,
  };
  const host = Host.layer({
    process: {
      run: (input) => {
        calls.push(input.args);
        if (input.args[1] === "list")
          return Effect.succeed(Host.processOutput(JSON.stringify({ items: [newest, older] })));
        if (input.args[1] === "view" && input.args[2] === "b")
          return Effect.succeed(
            Host.processOutput(
              JSON.stringify({
                ...newest,
                body: "Actual PR description",
                author: { did: "did:plc:alice", handle: "alice.example" },
              }),
            ),
          );
        return Effect.die("Unexpected tg command");
      },
    },
  });
  let pageReads = 0;
  const client = HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(
          ++pageReads > 1 &&
            (request.url.includes("state%3Aall") || request.url.includes("state:all"))
            ? '<a href="/alice.example/repo/pulls/2">Closed newest PR</a><a href="/alice.example/repo/pulls/1">Still open</a>'
            : '<a href="/alice.example/repo/pulls/1">Still open</a>',
        ),
      ),
    ),
  );
  return Effect.gen(function* () {
    const provider = yield* Provider.make;
    const reference = {
      cwd: "/repo",
      host: "tangled.org",
      repository: "alice.example/repo",
      number: 2,
    };
    const failed = yield* provider.getChangeRequestActivity(reference).pipe(Effect.flip);
    assert.match(failed.detail, /cannot be listed by number/u);
    const activity = yield* provider.getChangeRequestActivity(reference);
    assert.strictEqual(activity.author?.login, "alice.example");
    assert.strictEqual(activity.commentCount, 2);
    assert.strictEqual(activity.commentsTruncated, true);
    const detail = yield* provider.getChangeRequest(reference);
    assert.strictEqual(detail.body, "Actual PR description");
    assert.strictEqual(detail.number, 2);
    assert.strictEqual(detail.state, "closed");
    const list = yield* provider.listChangeRequests({
      ...reference,
      state: "all",
      involvement: "all",
      viewer: "alice.example",
      limit: 10,
    });
    assert.deepStrictEqual(
      list.items.map((pull) => [pull.number, pull.title]),
      [
        [1, "Still open"],
        [2, "Closed newest PR"],
      ],
    );
    assert.strictEqual(calls.filter((args) => args[1] === "view" && args[2] === "b").length, 2);
    assert.strictEqual(pageReads, 2);
  }).pipe(
    Effect.provide(Cli.layer.pipe(Layer.provideMerge(host))),
    Effect.provideService(HttpClient.HttpClient, client),
  );
});
