import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { IssueTrackerCredential } from "@t3tools/source-control-core/server/IssueTracker";
import * as IssueTrackerHost from "@t3tools/source-control-core/server/IssueTrackerHost";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";

import * as Driver from "./driver.ts";
import * as JiraApi from "./JiraApi.ts";
import * as TwgJiraAuth from "./TwgJiraAuth.ts";

const SITE = "https://acme.atlassian.net";
const CLOUD = "00000000-0000-4000-8000-000000000042";
const GATEWAY = `https://api.atlassian.com/ex/jira/${CLOUD}`;
const RESOURCES = "https://api.atlassian.com/oauth/token/accessible-resources";
const TWG: IssueTrackerCredential = {
  authentication: "environment",
  token: "",
  fields: { site: SITE },
};
const SAM = { accountId: "account", displayName: "Sam Rivera" };
const target = { cwd: "/w", host: "acme.atlassian.net" };
const PROFILES = [
  { name: "named", profile: "work" },
  { name: "default", profile: null },
];

/** An unsigned access token carrying the account and expiry TWG's OAuth tokens do. */
const jwt = (subject = "account", exp = 4_102_444_800) =>
  `${btoa("{}").replaceAll("=", "")}.${btoa(JSON.stringify({ sub: subject, exp })).replaceAll("=", "")}.signature`;

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
}

/** A synthetic TWG CLI and Atlassian: no real login, site or token is involved. */
function setup() {
  const processes: SourceControlHost.SourceControlProcessInput[] = [];
  const requests: Seen[] = [];
  const state = {
    credential: TWG,
    token: jwt(),
    profile: "work" as string | null,
    exported: undefined as string | undefined,
    context: "",
    exitCode: 0,
    onRefresh: () => {},
    respond: undefined as ((seen: Seen) => unknown) | undefined,
  };
  const first = state.token;
  const unexpected = () => Effect.die("Unexpected host call");
  const host = Layer.succeed(SourceControlHost.SourceControlHost, {
    settings: { get: unexpected(), getWithSecrets: unexpected, update: unexpected },
    git: {
      execute: unexpected,
      resolveCommit: unexpected,
      remotes: unexpected,
      readConfigValue: unexpected,
      resolvePrimaryRemoteName: unexpected,
      ensureRemote: unexpected,
      listLocalBranchNames: unexpected,
      fetchRemoteBranch: unexpected,
      fetchRemoteTrackingBranch: unexpected,
      setBranchUpstream: unexpected,
      createBranch: unexpected,
      writeConfigValue: unexpected,
      switchRef: unexpected,
    },
    process: {
      run: (input) =>
        Effect.sync(() => {
          processes.push(input);
          if (input.args[0] === "auth") state.onRefresh();
          const exported =
            state.exported ??
            [
              `export TWG_OAUTH_ACCESS_TOKEN=$'${state.token}'`,
              `export TWG_SITE=$'${SITE}'`,
              ...(state.profile === null ? [] : [`export TWG_PROFILE=$'${state.profile}'`]),
            ].join("\n");
          return {
            exitCode: ChildProcessSpawner.ExitCode(state.exitCode),
            stdout:
              input.args[0] === "env" ? exported : input.args[0] === "context" ? state.context : "",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }),
    },
  });
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const seen = {
          method: request.method,
          url: request.url,
          authorization: request.headers.authorization,
        };
        requests.push(seen);
        const value = state.respond
          ? state.respond(seen)
          : request.url === RESOURCES
            ? [{ id: CLOUD, url: SITE }]
            : request.url.endsWith("/project/search")
              ? { values: [{ key: "ENG", name: "Engineering" }] }
              : SAM;
        return HttpClientResponse.fromWeb(
          request,
          value instanceof Response ? value : Response.json(value),
        );
      }),
    ),
  );
  const credentials = Layer.succeed(IssueTrackerHost.IssueTrackerHost, {
    credentials: { get: () => Effect.sync(() => Option.some(state.credential)) },
  });
  const dependencies = Layer.mergeAll(host, http, credentials);
  /** A bare JiraApi with one operation's sessions, to drive a single request. */
  const operations = Effect.gen(function* () {
    const twg = yield* TwgJiraAuth.make;
    return () =>
      JiraApi.make.pipe(
        Effect.provideService(JiraApi.JiraSessions, twg.forSite(SITE, false)),
        Effect.provide(dependencies),
      );
  }).pipe(Effect.provide(dependencies));
  return {
    driver: Driver.make.pipe(Effect.provide(dependencies)),
    operations,
    processes,
    requests,
    first,
    state,
  };
}

const resources = (seen: Seen) => (seen.url === RESOURCES ? [{ id: CLOUD, url: SITE }] : null);

describe("TwgJiraAuth", () => {
  it.effect.each(PROFILES)(
    "connects with one export shared by the check's concurrent reads ($name profile)",
    ({ profile }) =>
      Effect.gen(function* () {
        const mock = setup();
        mock.state.profile = profile;
        const driver = yield* mock.driver;
        expect(yield* driver.probeCredential(TWG)).toEqual({
          account: "Sam Rivera",
          scopes: [{ key: "ENG", name: "Engineering" }],
        });
        yield* driver.getViewer(target);
        expect(mock.processes).toHaveLength(1);
        expect(mock.requests.filter((seen) => seen.url === RESOURCES)).toHaveLength(1);
      }),
  );

  it.effect(
    "sends OAuth requests through the gateway and reuses one export across operations",
    () =>
      Effect.gen(function* () {
        const mock = setup();
        const driver = yield* mock.driver;
        expect(yield* driver.getViewer(target)).toBe("Sam Rivera");
        expect(yield* driver.getViewer(target)).toBe("Sam Rivera");
        expect(mock.processes.map((call) => call.args)).toEqual([
          ["env", "--site", "acme.atlassian.net", "--export"],
        ]);
        expect(mock.requests.map((seen) => seen.url)).toEqual([
          RESOURCES,
          `${GATEWAY}/rest/api/3/myself`,
          `${GATEWAY}/rest/api/3/myself`,
        ]);
        expect(mock.requests.every((seen) => seen.authorization === `Bearer ${mock.first}`)).toBe(
          true,
        );
      }),
  );

  it.effect("coalesces cold requests and exports again before the token expires", () =>
    Effect.gen(function* () {
      const mock = setup();
      const now = yield* Clock.currentTimeMillis;
      mock.state.token = jwt("account", Math.floor(now / 1_000) + 60);
      const driver = yield* mock.driver;
      yield* Effect.all(
        Array.from({ length: 8 }, () => driver.getViewer(target)),
        { concurrency: "unbounded" },
      );
      expect(mock.processes).toHaveLength(1);
      yield* TestClock.adjust("56 seconds");
      mock.state.token = jwt();
      yield* driver.getViewer(target);
      expect(mock.processes).toHaveLength(2);
      expect(mock.requests.at(-1)?.authorization).toBe(`Bearer ${mock.state.token}`);
    }),
  );

  it.effect.each(PROFILES)(
    "refreshes once for refused reads, which share the replacement ($name profile)",
    ({ profile }) =>
      Effect.gen(function* () {
        const mock = setup();
        mock.state.profile = profile;
        const replacement = jwt("account", 4_102_444_900);
        mock.state.onRefresh = () => {
          mock.state.token = replacement;
        };
        mock.state.respond = (seen) =>
          resources(seen) ??
          (seen.authorization === `Bearer ${mock.first}`
            ? new Response(null, { status: 401 })
            : SAM);
        const driver = yield* mock.driver;
        yield* Effect.all(
          Array.from({ length: 4 }, () => driver.getViewer(target)),
          { concurrency: "unbounded" },
        );
        expect(
          mock.processes.filter((call) => call.args[0] === "auth").map((call) => call.args),
        ).toEqual([
          [
            "auth",
            "refresh",
            ...(profile === null ? ["--site", "acme.atlassian.net"] : ["--profile", profile]),
            "--force",
          ],
        ]);
        expect(mock.processes.filter((call) => call.args[0] === "env")).toHaveLength(2);
        expect(mock.requests.at(-1)?.authorization).toBe(`Bearer ${replacement}`);
      }),
  );

  it.effect.each(PROFILES)(
    "fails rather than continue an operation as another account ($name profile)",
    ({ profile }) =>
      Effect.gen(function* () {
        const mock = setup();
        mock.state.profile = profile;
        mock.state.onRefresh = () => {
          mock.state.token = jwt("someone-else");
        };
        mock.state.respond = (seen) => resources(seen) ?? new Response(null, { status: 401 });
        const driver = yield* mock.driver;
        const error = yield* driver.getViewer(target).pipe(Effect.flip);
        expect(error.detail).toContain("account changed");
        expect(mock.requests.filter((seen) => seen.url.endsWith("/myself"))).toHaveLength(1);
        expect(JSON.stringify(error)).not.toContain(mock.first);
        expect(JSON.stringify(error)).not.toContain(mock.state.token);
      }),
  );

  it.effect("reports a missing OAuth scope without refreshing a working session", () =>
    Effect.gen(function* () {
      const mock = setup();
      mock.state.respond = (seen) =>
        resources(seen) ??
        Response.json({ message: "Unauthorized; scope does not match" }, { status: 401 });
      const driver = yield* mock.driver;
      const error = yield* driver.getViewer(target).pipe(Effect.flip);
      expect(error).toMatchObject({ reason: "failed", detail: expect.stringContaining("login") });
      expect(mock.processes).toHaveLength(1);
      expect(mock.requests.filter((seen) => seen.url.endsWith("/myself"))).toHaveLength(1);
    }),
  );

  it.effect.each([401, 403, 429, 503])("never replays a refused write (HTTP %i)", (status) =>
    Effect.gen(function* () {
      const mock = setup();
      mock.state.respond = (seen) => resources(seen) ?? new Response(null, { status });
      const operation = yield* mock.operations;
      const api = yield* operation();
      yield* api.addComment("ENG-1", { type: "doc", content: [] }).pipe(Effect.flip);
      expect(mock.requests.filter((seen) => seen.method === "POST")).toHaveLength(1);
      expect(mock.processes).toHaveLength(1);
      if (status === 401) {
        // The refused session is not handed to the next operation.
        mock.state.respond = (seen) => resources(seen) ?? SAM;
        yield* (yield* operation()).myself();
        expect(mock.processes.filter((call) => call.args[0] === "auth")).toHaveLength(1);
      }
    }),
  );

  it.effect.each([
    "export TWG_OAUTH_ACCESS_TOKEN=$(echo unsafe)",
    "export TWG_OAUTH_ACCESS_TOKEN='secret'\nexport TWG_OAUTH_ACCESS_TOKEN='duplicate'",
    `export TWG_OAUTH_ACCESS_TOKEN='secret'\nexport TWG_SITE='https://other.atlassian.net'`,
  ])("refuses an unsafe or other-site export without repeating it: %s", (exported) =>
    Effect.gen(function* () {
      const mock = setup();
      mock.state.exported = exported;
      const driver = yield* mock.driver;
      const error = yield* driver.getViewer(target).pipe(Effect.flip);
      expect(error.reason).toBe("unauthenticated");
      expect(mock.requests).toHaveLength(0);
      expect(JSON.stringify(error)).not.toContain("secret");
      expect(JSON.stringify(error)).not.toContain("unsafe");
    }),
  );

  it.effect("sends the token nowhere but Atlassian when the site does not match exactly", () =>
    Effect.gen(function* () {
      const mock = setup();
      mock.state.respond = () => [{ id: CLOUD, url: `${SITE}.evil.test` }];
      const driver = yield* mock.driver;
      expect((yield* driver.getViewer(target).pipe(Effect.flip)).reason).toBe("unauthenticated");
      expect(mock.requests.map((seen) => seen.url)).toEqual([RESOURCES]);
    }),
  );

  it.effect("shares a signed-out failure briefly instead of running TWG for every request", () =>
    Effect.gen(function* () {
      const mock = setup();
      mock.state.exitCode = 1;
      const driver = yield* mock.driver;
      yield* Effect.all(
        Array.from({ length: 8 }, () => driver.getViewer(target).pipe(Effect.flip)),
        { concurrency: "unbounded" },
      );
      expect(mock.processes).toHaveLength(1);
      expect(mock.requests).toHaveLength(0);
      yield* TestClock.adjust("10 seconds");
      mock.state.exitCode = 0;
      yield* driver.getViewer(target);
      expect(mock.processes).toHaveLength(2);
    }),
  );

  it.effect("honors Retry-After while finding the site, even for a connection check", () =>
    Effect.gen(function* () {
      const mock = setup();
      const now = yield* Clock.currentTimeMillis;
      mock.state.respond = () =>
        new Response(null, { status: 429, headers: { "Retry-After": "40" } });
      const driver = yield* mock.driver;
      expect((yield* driver.getViewer(target).pipe(Effect.flip)).retryAt).toBe(now + 40_000);
      yield* TestClock.adjust("10 seconds");
      yield* driver.probeCredential(TWG).pipe(Effect.flip);
      expect(mock.processes).toHaveLength(1);
      expect(mock.requests).toHaveLength(1);
      yield* TestClock.adjust("30 seconds");
      mock.state.respond = undefined;
      yield* driver.getViewer(target);
      expect(mock.processes).toHaveLength(2);
    }),
  );

  it.effect.each(PROFILES)(
    "signs a TWG API-token login against the site, keeping the token in TWG ($name profile)",
    ({ profile }) =>
      Effect.gen(function* () {
        const mock = setup();
        mock.state.exported = [
          "export TWG_TOKEN=$'api-key'",
          "export TWG_USER=$'sam@example.test'",
          `export TWG_SITE=$'${SITE}'`,
          ...(profile === null ? [] : [`export TWG_PROFILE=$'${profile}'`]),
        ].join("\n");
        const driver = yield* mock.driver;
        yield* driver.getViewer(target);
        expect(mock.requests).toEqual([
          expect.objectContaining({
            url: `${SITE}/rest/api/3/myself`,
            authorization: `Basic ${btoa("sam@example.test:api-key")}`,
          }),
        ]);
        // The site serves its development panel to a token, so TWG is not asked for it.
        mock.state.respond = () => ({ summary: {} });
        const operation = yield* mock.operations;
        expect(yield* (yield* operation()).developmentPullRequests("10007")).toEqual([]);
        expect(mock.requests.at(-1)?.url).toBe(`${SITE}/rest/dev-status/latest/issue/summary`);
        expect(mock.processes.some((call) => call.args[0] === "context")).toBe(false);
      }),
  );

  it.effect("reads an OAuth session's linked pull requests with TWG, not through the gateway", () =>
    Effect.gen(function* () {
      const mock = setup();
      const pullRequest = (number: number, title: string) => ({
        ari: `ari:cloud:jira:${CLOUD}:pull-request/${number}`,
        type: "ExternalPullRequest",
        title,
        name: title,
        url: `https://github.com/acme/web/pull/${number}`,
        status: "MERGED",
        displayId: `#${number}`,
        pullRequestId: String(number),
        provider: { name: "GitHub" },
      });
      mock.state.context = JSON.stringify({
        apiVersion: "1",
        command: "context.jira.workitem",
        data: {
          object: { ari: `ari:cloud:jira:${CLOUD}:issue/10007`, type: "JiraIssue" },
          relationships: [
            {
              relationshipName: "jira_work_item_links_external_pull_request",
              direction: "forward",
              targetType: "ExternalPullRequest",
              targets: [pullRequest(482, "Keep the return path")],
            },
            {
              relationshipName: "external_pull_request_mentions_jira_work_item",
              direction: "inverse",
              targetType: "ExternalPullRequest",
              targets: [pullRequest(9, "Only mentions it")],
            },
          ],
        },
        meta: {},
      });
      const operation = yield* mock.operations;
      expect(yield* (yield* operation()).developmentPullRequests("10007")).toEqual([
        {
          id: "#482",
          name: "Keep the return path",
          url: "https://github.com/acme/web/pull/482",
          status: "MERGED",
        },
      ]);
      expect(mock.processes.at(-1)?.args).toEqual([
        "context",
        "jira",
        "workitem",
        "10007",
        "--site",
        "acme.atlassian.net",
        "--profile",
        "work",
        "--relationships",
        "jira_work_item_links_external_pull_request",
        "--detail",
        "full",
        "--since",
        "3650d",
        "--output",
        "json",
        "--output-summary",
        "none",
      ]);
      expect(mock.requests.some((seen) => seen.url.includes("/rest/dev-status/"))).toBe(false);

      // Anything but a context answer is refused rather than read, and never echoed.
      mock.state.context = `export TWG_OAUTH_ACCESS_TOKEN=$'${mock.first}'`;
      const refused = yield* (yield* operation())
        .developmentPullRequests("10007")
        .pipe(Effect.flip);
      expect(refused.detail).toBe("TWG could not read the issue's linked pull requests.");
      expect(JSON.stringify(refused)).not.toContain(mock.first);
    }),
  );

  it.effect("keeps one login through a whole write, then follows what Settings saved next", () =>
    Effect.gen(function* () {
      const mock = setup();
      mock.state.respond = (seen) => {
        if (seen.url === RESOURCES) return [{ id: CLOUD, url: SITE }];
        if (seen.url.endsWith("/issue/ENG-1") && seen.method === "GET") {
          // Settings switches to an API token while the edit is under way.
          mock.state.credential = {
            token: "api-key",
            fields: { site: "other", email: "sam@example.test" },
          };
          return {
            id: "1",
            key: "ENG-1",
            fields: {
              summary: "Edit me",
              status: { name: "Open" },
              created: "2026-01-01T00:00:00.000+0000",
              updated: "2026-01-02T00:00:00.000+0000",
            },
          };
        }
        if (seen.method === "PUT") return new Response(null, { status: 204 });
        return SAM;
      };
      const driver = yield* mock.driver;
      yield* driver.update!({ ...target, scope: "ENG", key: "ENG-1", body: "New description" });
      expect(mock.requests.find((seen) => seen.method === "PUT")).toEqual({
        method: "PUT",
        url: `${GATEWAY}/rest/api/3/issue/ENG-1`,
        authorization: `Bearer ${mock.first}`,
      });
      yield* driver.getViewer(target);
      expect(mock.requests.at(-1)).toMatchObject({
        url: "https://other.atlassian.net/rest/api/3/myself",
        authorization: `Basic ${btoa("sam@example.test:api-key")}`,
      });
      expect(mock.processes).toHaveLength(1);
    }),
  );
});
