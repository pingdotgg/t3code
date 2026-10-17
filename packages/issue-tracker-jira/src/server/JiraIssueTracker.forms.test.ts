import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Crypto from "effect/Crypto";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { IssueCandidates, IssueFieldValues } from "@t3tools/contracts";
import { IssueTrackerHost } from "@t3tools/issue-tracker-core/server/IssueTrackerHost";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import { IssueTrackerError } from "@t3tools/issue-tracker-core/server/IssueTracker";
import * as JiraApi from "./JiraApi.ts";
import * as JiraIssueTracker from "./JiraIssueTracker.ts";

const target = { cwd: "/tmp", host: "example.atlassian.net", scope: "ENG", key: "ENG-1" };
const isTrackerError = Schema.is(IssueTrackerError);
const decodeCandidates = Schema.decodeEffect(IssueCandidates);
const decodeFieldValues = Schema.decodeEffect(IssueFieldValues);
const status = { id: "2", name: "Review", statusCategory: { key: "indeterminate" } };
const document = {
  type: "doc",
  version: 1,
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Body", marks: [{ type: "strong" }] }] },
    {
      type: "mediaSingle",
      attrs: { layout: "center", native: { keep: true } },
      content: [{ type: "media", attrs: { type: "file", id: "file-1", collection: "files" } }],
    },
  ],
};
const issue = {
  key: "ENG-1",
  fields: {
    project: { id: "20", key: "ENG" },
    status,
    summary: "Task",
    description: document,
    created: "2026-10-14T10:00:00Z",
    updated: "2026-10-14T10:00:00Z",
    comment: { total: 0, comments: [] },
  },
  changelog: { startAt: 0, total: 0, histories: [] },
};
const comment = {
  id: "c1",
  body: document,
  author: { accountId: "me" },
  created: issue.fields.created,
  updated: issue.fields.updated,
};
const fields = [
  {
    fieldId: "summary",
    name: "Summary",
    required: true,
    schema: { type: "string", system: "summary" },
  },
  {
    fieldId: "customfield_1",
    name: "Impact",
    required: true,
    schema: { type: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:select" },
    allowedValues: [{ id: "major", value: "Major" }],
  },
  { fieldId: "customfield_2", name: "Effort", required: true, schema: { type: "number" } },
];
function fixture(
  overrides: (path: string, method: string) => unknown = () => undefined,
  deployment: "cloud" | "data-center" = "cloud",
) {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const service = JiraApi.JiraApi.of({
    deploymentFor: () => Effect.succeed(deployment),
    request: (input) => {
      calls.push(input);
      const custom = overrides(input.path, input.method);
      if (isTrackerError(custom)) return Effect.fail(custom);
      const raw =
        custom ??
        (input.method !== "GET"
          ? input.path.endsWith("/comment/c1")
            ? comment
            : { key: "ENG-2" }
          : input.path.includes("/createmeta/")
            ? input.path.includes("/issuetypes/")
              ? { startAt: 0, total: fields.length, fields }
              : { startAt: 0, total: 1, issueTypes: [{ id: "task", name: "Task" }] }
            : input.path.includes("/mypermissions?")
              ? {
                  permissions: {
                    CREATE_ISSUES: { havePermission: true },
                    EDIT_ISSUES: { havePermission: true },
                  },
                }
              : input.path === "/myself"
                ? { accountId: "me" }
                : input.path.endsWith("/remotelink")
                  ? []
                  : input.path.includes("/transitions?")
                    ? { transitions: [] }
                    : input.path.endsWith("/comment/c1")
                      ? comment
                      : input.path.endsWith("/statuses")
                        ? []
                        : issue);
      const empty =
        input.method !== "GET" &&
        input.path !== "/issue" &&
        !input.path.endsWith("/comment/c1") &&
        input.path !== "/search/jql";
      return Schema.decodeEffect(input.schema)(empty ? undefined : raw).pipe(
        Effect.mapError(() => JiraApi.failed(input.operation, "Invalid fixture response.")),
      );
    },
    probeCredential: () => Effect.die("unused"),
    getScope: () => Effect.die("unused"),
    listScopes: () => Effect.die("unused"),
  });
  return {
    calls,
    api: JiraIssueTracker.make.pipe(Effect.provideService(JiraApi.JiraApi, service)),
  };
}
const create = { ...target, title: "New", body: "", labels: [], assignees: [], issueType: "task" };

function nativeFormFixture(
  deployment: "cloud" | "data-center",
  page: (startAt: number) => unknown,
  writeStatus = 201,
  transitionFields?: Record<string, unknown>,
) {
  const host = deployment === "cloud" ? target.host : "jira.example.test/Team/Jira";
  const calls: HttpClientRequest.HttpClientRequest[] = [];
  const http = HttpClient.make((request) => {
    calls.push(request);
    const url = new URL(request.url);
    const write = request.method === "POST" && url.pathname.endsWith("/issue");
    const transition = url.pathname.endsWith("/transitions");
    const raw = write
      ? { key: "ENG-2" }
      : url.pathname.endsWith("/issuetypes/task")
        ? page(Number(url.searchParams.get("startAt")))
        : url.pathname.endsWith("/issuetypes")
          ? {
              startAt: 0,
              total: 1,
              [deployment === "cloud" ? "issueTypes" : "values"]: [{ id: "task", name: "Task" }],
            }
          : transition
            ? { transitions: [{ id: "advance", to: status, fields: transitionFields ?? {} }] }
            : url.pathname.endsWith("/issue/ENG-1")
              ? issue
              : url.pathname.endsWith("/mypermissions")
                ? { permissions: { CREATE_ISSUES: { havePermission: true } } }
                : url.pathname.endsWith("/statuses")
                  ? []
                  : { startAt: 0, total: 0, issues: [] };
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(transition && request.method === "POST" ? null : JSON.stringify(raw), {
          status: transition && request.method === "POST" ? 204 : write ? writeStatus : 200,
        }),
      ),
    );
  });
  const credential =
    deployment === "cloud"
      ? { site: host, email: "ada@example.test", token: "fake-token" }
      : { deployment, site: "https://" + host, token: "fake-pat" };
  const transport = JiraApi.make.pipe(
    Effect.provideService(HttpClient.HttpClient, http),
    Effect.provideService(
      IssueTrackerHost,
      IssueTrackerHost.of({
        credentials: { get: () => Effect.succeedSome(JSON.stringify(credential)) },
      }),
    ),
    Effect.provide(SourceControlRateLimit.layer),
    Effect.provideService(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: (_algorithm, data) => Effect.succeed(data),
      }),
    ),
  );
  return {
    host,
    calls,
    api: JiraIssueTracker.make.pipe(Effect.provideServiceEffect(JiraApi.JiraApi, transport)),
  };
}

const largeForm = (count: number, required = false) => [
  fields[0]!,
  ...Array.from({ length: count - 1 }, (_, index) => ({
    fieldId: "customfield_" + (index + 1),
    name: "Field " + (index + 1),
    required,
    schema: { type: "string" },
  })),
];

it.effect.each(["cloud", "data-center"] as const)(
  "writes native cascading parent and child on create and transition for %s",
  (deployment) =>
    Effect.gen(function* () {
      for (const type of ["array", "option"]) {
        const field = {
          fieldId: "customfield_cascade",
          name: "Location",
          required: true,
          schema: {
            type,
            items: "string",
            custom: "com.atlassian.jira.plugin.system.customfieldtypes:cascadingselect",
          },
          allowedValues: [
            { id: "10", value: "A", children: [{ id: "11", value: "A1" }] },
            { id: "20", value: "B", children: [{ id: "21", value: "B1" }] },
          ],
        };
        const f = nativeFormFixture(
          deployment,
          () => ({
            startAt: 0,
            total: 2,
            [deployment === "cloud" ? "fields" : "values"]: [fields[0], field],
          }),
          201,
          { customfield_cascade: field },
        );
        const api = yield* f.api;
        const selected = { ...target, host: f.host };
        const candidates = yield* api.listCandidates!({
          ...selected,
          key: undefined,
          issueType: "task",
        });
        expect((yield* decodeCandidates(candidates)).fields?.[0]).toMatchObject({
          kind: "cascading-select",
          options: [
            { value: "10", children: [{ value: "11" }] },
            { value: "20", children: [{ value: "21" }] },
          ],
        });
        f.calls.length = 0;
        const value = '{"id":"10","child":{"id":"11"}}';
        yield* api.create!({
          ...create,
          host: f.host,
          fieldValues: { customfield_cascade: value },
        });
        yield* api.setState!({
          ...selected,
          state: status.id,
          transitionId: "advance",
          fieldValues: { customfield_cascade: value },
        });
        expect(f.calls.map(({ method }) => method)).toEqual([
          "GET",
          "GET",
          "POST",
          "GET",
          "GET",
          "POST",
        ]);
        const writes = f.calls
          .filter(({ method }) => method === "POST")
          .map((call) => {
            if (call.body._tag !== "Uint8Array") throw new Error("Expected native JSON body.");
            return JSON.parse(new TextDecoder().decode(call.body.body));
          });
        expect(writes).toEqual([
          {
            fields: {
              project: { key: "ENG" },
              issuetype: { id: "task" },
              summary: "New",
              customfield_cascade: { id: "10", child: { id: "11" } },
            },
          },
          {
            transition: { id: "advance" },
            fields: { customfield_cascade: { id: "10", child: { id: "11" } } },
          },
        ]);
        for (const invalid of [
          '{"id":"10","child":{"id":"21"}}',
          '{"id":"10","extra":true}',
          '{"id":"10","child":{"id":"11","child":{"id":"12"}}}',
          '["10","11"]',
        ]) {
          f.calls.length = 0;
          yield* api.create!({
            ...create,
            host: f.host,
            fieldValues: { customfield_cascade: invalid },
          }).pipe(Effect.flip);
          yield* api.setState!({
            ...selected,
            state: status.id,
            transitionId: "advance",
            fieldValues: { customfield_cascade: invalid },
          }).pipe(Effect.flip);
          expect(f.calls.map(({ method }) => method)).toEqual(["GET", "GET", "GET", "GET"]);
        }
        field.allowedValues[0]!.children = [];
        f.calls.length = 0;
        yield* api.create!({
          ...create,
          host: f.host,
          fieldValues: { customfield_cascade: value },
        }).pipe(Effect.flip);
        expect(f.calls.map(({ method }) => method)).toEqual(["GET", "GET"]);
      }
    }),
);

it.effect.each(["cloud", "data-center"] as const)(
  "reads every native create field across pages and writes 101 required values for %s",
  (deployment) =>
    Effect.gen(function* () {
      const metadata = largeForm(102, true);
      const f = nativeFormFixture(deployment, (startAt) => ({
        startAt,
        total: 102,
        [deployment === "cloud" ? "fields" : "values"]: metadata.slice(startAt, startAt + 100),
      }));
      const api = yield* f.api;
      const candidates = yield* api.listCandidates!({
        ...target,
        host: f.host,
        key: undefined,
        issueType: "task",
      });
      expect((yield* decodeCandidates(candidates)).fields).toHaveLength(101);
      expect(candidates.fields?.at(-1)).toMatchObject({ id: "customfield_101", required: true });
      f.calls.length = 0;
      const fieldValues = yield* decodeFieldValues(
        Object.fromEntries(metadata.slice(1).map((field) => [field.fieldId, "Set"])),
      );
      yield* api.create!({ ...create, host: f.host, fieldValues });
      expect(f.calls.map(({ method }) => method)).toEqual(["GET", "GET", "GET", "POST"]);
      expect(f.calls.map(({ url }) => new URL(url).searchParams.get("startAt"))).toEqual([
        "0",
        "0",
        "100",
        null,
      ]);
      const write = f.calls.at(-1)!;
      expect(write.url).toBe(
        "https://" + f.host + (deployment === "cloud" ? "/rest/api/3/issue" : "/rest/api/2/issue"),
      );
      expect(write.headers.authorization).toBe(
        deployment === "cloud" ? "Basic " + btoa("ada@example.test:fake-token") : "Bearer fake-pat",
      );
      if (write.body._tag !== "Uint8Array") throw new Error("Expected native JSON body.");
      const payload = JSON.parse(new TextDecoder().decode(write.body.body));
      expect(payload.fields.customfield_101).toBe("Set");
      expect(Object.keys(payload.fields)).toHaveLength(104);
      f.calls.length = 0;
      const missing = Object.fromEntries(
        Object.entries(fieldValues).filter(([id]) => id !== "customfield_101"),
      );
      yield* api.create!({ ...create, host: f.host, fieldValues: missing }).pipe(Effect.flip);
      expect(f.calls.map(({ method }) => method)).toEqual(["GET", "GET", "GET"]);
    }),
);

it.effect.each(["cloud", "data-center"] as const)(
  "accepts the terminal 1000th native field with total or isLast for %s",
  (deployment) =>
    Effect.gen(function* () {
      for (const withTotal of [true, false]) {
        const metadata = largeForm(1000);
        const f = nativeFormFixture(deployment, (startAt) => ({
          startAt,
          ...(withTotal ? { total: 1000 } : { isLast: startAt === 900 }),
          [deployment === "cloud" ? "fields" : "values"]: metadata.slice(startAt, startAt + 100),
        }));
        yield* (yield* f.api).create!({
          ...create,
          host: f.host,
          fieldValues: { customfield_999: "Last" },
        });
        expect(f.calls).toHaveLength(12);
        expect(f.calls.filter(({ method }) => method === "POST")).toHaveLength(1);
        expect(f.calls.at(-2)?.url).toContain("startAt=900&maxResults=100");
      }
    }),
);

it.effect.each(["cloud", "data-center"] as const)(
  "refuses incomplete, oversized or inconsistent native field pages before a write for %s",
  (deployment) =>
    Effect.gen(function* () {
      const metadata = largeForm(102);
      const cases = [
        { name: "total beyond bound", first: { total: 1001 }, reads: 2 },
        { name: "oversized page", first: { fields: metadata }, reads: 2 },
        { name: "empty nonterminal page", first: { fields: [] }, reads: 2 },
        { name: "missing completion", first: { total: undefined }, reads: 2 },
        { name: "looped offset", second: { startAt: 0 }, reads: 3 },
        { name: "changed total", second: { total: 103 }, reads: 3 },
        { name: "missing total", second: { total: undefined, isLast: false }, reads: 3 },
        { name: "premature last", first: { isLast: true }, reads: 2 },
        { name: "false last", second: { isLast: false }, reads: 3 },
        { name: "duplicate identity", second: { fields: [metadata[0], metadata[0]] }, reads: 3 },
        {
          name: "unsafe identity",
          second: { fields: [{ fieldId: "__proto__" }, metadata[101]] },
          reads: 3,
        },
      ];
      for (const test of cases) {
        const f = nativeFormFixture(deployment, (startAt) => {
          const page = {
            startAt,
            total: 102,
            fields: metadata.slice(startAt, startAt + 100),
            ...(startAt === 0 ? test.first : test.second),
          };
          return deployment === "cloud"
            ? page
            : { ...page, fields: undefined, values: page.fields };
        });
        yield* (yield* f.api).create!({ ...create, host: f.host }).pipe(Effect.flip);
        expect(
          f.calls.map(({ method }) => method),
          test.name,
        ).toEqual(Array(test.reads).fill("GET"));
      }
      const metadataAtBound = largeForm(1000);
      const looping = nativeFormFixture(deployment, (startAt) => ({
        startAt,
        isLast: false,
        [deployment === "cloud" ? "fields" : "values"]: metadataAtBound.slice(
          startAt,
          startAt + 100,
        ),
      }));
      yield* (yield* looping.api).create!({ ...create, host: looping.host }).pipe(Effect.flip);
      expect(looping.calls).toHaveLength(11);
      expect(looping.calls.every(({ method }) => method === "GET")).toBe(true);
    }),
);

it.effect.each(["cloud", "data-center"] as const)(
  "keeps native authorization and rate failures after large metadata reads for %s",
  (deployment) =>
    Effect.gen(function* () {
      const metadata = largeForm(102);
      for (const status of [403, 429]) {
        const f = nativeFormFixture(
          deployment,
          (startAt) => ({
            startAt,
            total: 102,
            [deployment === "cloud" ? "fields" : "values"]: metadata.slice(startAt, startAt + 100),
          }),
          status,
        );
        const error = yield* (yield* f.api).create!({ ...create, host: f.host }).pipe(Effect.flip);
        expect(error.detail).toContain(String(status));
        expect(error.reason).toBe(status === 429 ? "rate-limited" : "failed");
        expect(f.calls.map(({ method }) => method)).toEqual(["GET", "GET", "GET", "POST"]);
      }
    }),
);

it.effect("keeps 101 required native transition fields through candidates and writes", () =>
  Effect.gen(function* () {
    const metadata = Object.fromEntries(
      largeForm(102, true)
        .slice(1)
        .map((field) => [field.fieldId, field]),
    );
    const f = fixture((path) =>
      path.includes("/transitions?")
        ? { transitions: [{ id: "advance", to: status, fields: metadata }] }
        : path === "/search/jql"
          ? { issues: [] }
          : undefined,
    );
    const api = yield* f.api;
    const candidates = yield* api.listCandidates!(target);
    expect((yield* decodeCandidates(candidates)).states?.[0]?.fields).toHaveLength(101);
    f.calls.length = 0;
    const fieldValues = Object.fromEntries(Object.keys(metadata).map((id) => [id, "Set"]));
    yield* api.setState!({ ...target, state: status.id, transitionId: "advance", fieldValues });
    expect(f.calls.map(({ method }) => method)).toEqual(["GET", "GET", "POST"]);
    expect(f.calls.at(-1)?.body).toEqual({ transition: { id: "advance" }, fields: fieldValues });
  }),
);

it.effect("creates native required select and numeric fields without losing them", () =>
  Effect.gen(function* () {
    const f = fixture();
    const api = yield* f.api;
    yield* api.create!({
      ...create,
      fieldValues: { customfield_1: "major", customfield_2: "3.5" },
    });
    expect(f.calls.find((call) => call.method === "POST")?.body).toEqual({
      fields: {
        project: { key: "ENG" },
        issuetype: { id: "task" },
        summary: "New",
        customfield_1: { id: "major" },
        customfield_2: 3.5,
      },
    });
  }),
);

it.effect("returns fields only for the selected issue type", () =>
  Effect.gen(function* () {
    const f = fixture((path) => (path === "/search/jql" ? { issues: [] } : undefined));
    const api = yield* f.api;
    const result = yield* api.listCandidates!({ ...target, key: undefined, issueType: "task" });
    expect(result.fields).toEqual([
      {
        id: "customfield_1",
        label: "Impact",
        required: true,
        kind: "select",
        options: [{ value: "major", label: "Major" }],
      },
      { id: "customfield_2", label: "Effort", required: true, kind: "number" },
    ]);
    expect(f.calls.filter((call) => call.path.includes("/issuetypes/"))).toHaveLength(1);
  }),
);

it.effect.each([
  { customfield_1: "unknown", customfield_2: "3" },
  { customfield_1: "major" },
  { summary: "override", customfield_1: "major", customfield_2: "3" },
  { customfield_999: "ignored", customfield_1: "major", customfield_2: "3" },
])(
  "refuses invalid, missing, reserved or unknown field values before mutation: %j",
  (fieldValues) =>
    Effect.gen(function* () {
      const f = fixture();
      const api = yield* f.api;
      yield* api.create!({ ...create, fieldValues }).pipe(Effect.flip);
      expect(f.calls.filter((call) => call.method !== "GET")).toEqual([]);
    }),
);

it.effect("keeps transition identity separate from its destination and sends required inputs", () =>
  Effect.gen(function* () {
    const transitionFields = {
      resolution: {
        name: "Resolution",
        required: true,
        schema: { type: "resolution" },
        allowedValues: [{ id: "fixed", name: "Fixed" }],
      },
    };
    const f = fixture((path) =>
      path.includes("/transitions?")
        ? {
            transitions: [
              { id: "finish", to: status, fields: transitionFields },
              { id: "review", to: status, fields: {} },
            ],
          }
        : undefined,
    );
    const api = yield* f.api;
    yield* api.setState!({
      ...target,
      state: status.id,
      transitionId: "finish",
      fieldValues: { resolution: "fixed" },
    });
    expect(f.calls.at(-1)?.body).toEqual({
      transition: { id: "finish" },
      fields: { resolution: { id: "fixed" } },
    });
  }),
);

it.effect("round trips native ADF descriptions and comments without flattening", () =>
  Effect.gen(function* () {
    const f = fixture();
    const api = yield* f.api;
    const detail = yield* api.getIssue(target);
    expect(detail.bodyEditable).toBe(false);
    expect(detail.richBody).toEqual({ format: "adf", document: JSON.stringify(document) });
    const richBody = { format: "adf" as const, document: JSON.stringify(document) };
    yield* api.update!({ ...target, body: "Legacy text", richBody });
    yield* api.editComment!({ ...target, commentId: "c1", body: "Legacy text", richBody });
    expect(f.calls.filter((call) => call.method === "PUT").map((call) => call.body)).toEqual([
      { fields: { description: document } },
      { body: document },
    ]);
    expect(f.calls.filter((call) => call.path.startsWith("/issue/ENG-1?"))).toHaveLength(3);
  }),
);

it.effect("reads native generic remote links only after the selected project check", () =>
  Effect.gen(function* () {
    const f = fixture((path) =>
      path.endsWith("/remotelink")
        ? [
            { object: { title: "Review", url: "https://git.example/pr/1" } },
            { object: { title: "Bad", url: "javascript:alert(1)" } },
          ]
        : undefined,
    );
    const api = yield* f.api;
    const detail = yield* api.getIssue(target);
    expect(detail.externalLinks).toEqual([{ title: "Review", url: "https://git.example/pr/1" }]);
    expect(detail.linkedPullRequests).toEqual([]);
    expect(f.calls.filter((call) => call.path.endsWith("/remotelink"))).toHaveLength(1);
    const denied = fixture((path) =>
      path.startsWith("/issue/ENG-1?")
        ? { ...issue, fields: { ...issue.fields, project: { id: "30", key: "OTHER" } } }
        : undefined,
    );
    yield* (yield* denied.api).getIssue(target).pipe(Effect.flip);
    expect(denied.calls).toHaveLength(1);
  }),
);

it.effect(
  "loads bounded native metadata pages with total or isLast without scanning other types",
  () =>
    Effect.gen(function* () {
      for (const withTotal of [true, false]) {
        const f = fixture((path) => {
          if (!path.includes("/issuetypes/task?")) return undefined;
          const startAt = Number(new URL("https://jira.test" + path).searchParams.get("startAt"));
          return {
            startAt,
            ...(withTotal ? { total: fields.length } : { isLast: startAt === 1 }),
            fields: startAt === 0 ? fields.slice(0, 1) : fields.slice(1),
          };
        });
        yield* (yield* f.api).create!({
          ...create,
          fieldValues: { customfield_1: "major", customfield_2: "5" },
        });
        expect(f.calls.filter((call) => call.path.includes("/issuetypes/task?"))).toHaveLength(2);
        expect(f.calls.at(-1)?.method).toBe("POST");
      }
    }),
);
it.effect.each([
  { startAt: 1, total: 3, fields },
  { startAt: 0, total: 101, fields },
  { startAt: 0, total: 3, fields: [] },
  { startAt: 0, fields },
  { startAt: 0, total: 3, isLast: true, fields: fields.slice(0, 1) },
  { startAt: 0, total: 3, isLast: false, fields },
  { startAt: 0, total: 2, fields: [fields[0], fields[0]] },
])("refuses incomplete or inconsistent form metadata without a mutation: %j", (page) =>
  Effect.gen(function* () {
    const f = fixture((path) => (path.includes("/issuetypes/task?") ? page : undefined));
    yield* (yield* f.api).create!({
      ...create,
      fieldValues: { customfield_1: "major", customfield_2: "1" },
    }).pipe(Effect.flip);
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  }),
);
it.effect("refreshes field options and transition availability before each write", () =>
  Effect.gen(function* () {
    let available = true;
    const f = fixture((path) =>
      path.includes("/transitions?")
        ? {
            transitions: [
              {
                id: "finish",
                to: status,
                isAvailable: available,
                fields: {
                  resolution: {
                    required: true,
                    name: "Resolution",
                    schema: { type: "resolution" },
                    allowedValues: [{ id: "fixed", name: "Fixed" }],
                  },
                },
              },
            ],
          }
        : undefined,
    );
    const api = yield* f.api;
    yield* api.setState!({
      ...target,
      state: status.id,
      transitionId: "finish",
      fieldValues: { resolution: "fixed" },
    });
    available = false;
    yield* api.setState!({
      ...target,
      state: status.id,
      transitionId: "finish",
      fieldValues: { resolution: "fixed" },
    }).pipe(Effect.flip);
    expect(f.calls.filter((call) => call.method !== "GET")).toHaveLength(1);
    expect(f.calls.filter((call) => call.path.includes("/transitions?"))).toHaveLength(2);
  }),
);
it.effect.each(["[]", "null", '{"type":"doc","version":2,"content":[]}'])(
  "rejects invalid rich writes and keeps legacy rich edits protected: %s",
  (document) =>
    Effect.gen(function* () {
      const f = fixture();
      const api = yield* f.api;
      yield* api.update!({ ...target, body: "legacy" }).pipe(Effect.flip);
      yield* api.update!({ ...target, body: "legacy", richBody: { format: "adf", document } }).pipe(
        Effect.flip,
      );
      yield* api.editComment!({
        ...target,
        body: "legacy",
        commentId: "c1",
        richBody: { format: "adf", document },
      }).pipe(Effect.flip);
      expect(f.calls.every((call) => call.method === "GET")).toBe(true);
    }),
);

it.effect("reports remote link permission errors and refuses oversized results", () =>
  Effect.gen(function* () {
    for (const reply of [
      JiraApi.failed("getIssue", "Jira returned HTTP 403."),
      Array.from({ length: 101 }, () => ({
        object: { title: "Link", url: "https://example.test" },
      })),
    ]) {
      const f = fixture((path) => (path.endsWith("/remotelink") ? reply : undefined));
      yield* (yield* f.api).getIssue(target).pipe(Effect.flip);
      expect(f.calls.filter((call) => call.path.endsWith("/remotelink"))).toHaveLength(1);
      expect(f.calls.every((call) => call.method === "GET")).toBe(true);
    }
  }),
);
it.effect("keeps Data Center native wiki editing and disables unsupported parent edits", () =>
  Effect.gen(function* () {
    const f = fixture(
      (path) =>
        path.startsWith("/issue/ENG-1?")
          ? { ...issue, fields: { ...issue.fields, description: "h1. Native wiki" } }
          : undefined,
      "data-center",
    );
    const api = yield* f.api;
    const detail = yield* api.getIssue(target);
    expect(detail.body).toBe("h1. Native wiki");
    expect(detail.bodyEditable).toBe(false);
    expect(detail.richBody).toEqual({ format: "jira-wiki", document: "h1. Native wiki" });
    expect(detail.capabilities).toMatchObject({ updateParent: false, richText: true });
    expect(detail.viewerPermissions.updateParent).toBe(false);
    f.calls.length = 0;
    yield* api.setParent!({ ...target, parentKey: "ENG-2" }).pipe(Effect.flip);
    expect(f.calls.map(({ method }) => method)).toEqual(["GET"]);
    yield* api.update!({ ...target, body: "native wiki" }).pipe(Effect.flip);
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
    f.calls.length = 0;
    yield* api.update!({
      ...target,
      body: "legacy",
      richBody: { format: "adf", document: JSON.stringify(document) },
    }).pipe(Effect.flip);
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  }),
);
it.effect("does not invent Data Center assignee continuation cursors", () =>
  Effect.gen(function* () {
    const f = fixture(
      (path) =>
        path.startsWith("/user/assignable/search?")
          ? Array.from({ length: 100 }, (_, index) => ({
              accountId: String(index),
              displayName: "User " + index,
            }))
          : undefined,
      "data-center",
    );
    const api = yield* f.api;
    const page = yield* api.listAssigneeCandidates!(target);
    expect(page).toMatchObject({ nextCursor: null, truncated: true });
    expect(page.items).toHaveLength(100);
    f.calls.length = 0;
    yield* api.listAssigneeCandidates!({ ...target, cursor: "100" }).pipe(Effect.flip);
    expect(f.calls).toEqual([]);
  }),
);
it.effect(
  "keeps native description, label and assignee defaults when the form leaves them empty",
  () =>
    Effect.gen(function* () {
      const f = fixture((path) =>
        path.includes("/issuetypes/task?")
          ? {
              startAt: 0,
              total: 4,
              fields: [
                fields[0],
                ...["description", "labels", "assignee"].map((fieldId) => ({
                  fieldId,
                  required: true,
                  hasDefaultValue: true,
                })),
              ],
            }
          : undefined,
      );
      yield* (yield* f.api).create!(create);
      expect(f.calls.at(-1)?.body).toEqual({
        fields: { project: { key: "ENG" }, issuetype: { id: "task" }, summary: "New" },
      });
    }),
);
it.effect.each(["description", "labels", "assignee", "parent"])(
  "refuses missing native required primary field %s before mutation",
  (fieldId) =>
    Effect.gen(function* () {
      const f = fixture((path) =>
        path.includes("/issuetypes/task?")
          ? { startAt: 0, total: 2, fields: [fields[0], { fieldId, required: true }] }
          : undefined,
      );
      yield* (yield* f.api).create!(create).pipe(Effect.flip);
      expect(f.calls.every((call) => call.method === "GET")).toBe(true);
    }),
);
it.effect(
  "keeps native authorization on rich writes and rejects foreign scope before each write",
  () =>
    Effect.gen(function* () {
      const richBody = { format: "adf" as const, document: JSON.stringify(document) };
      const denied = fixture((_path, method) =>
        method === "PUT" ? JiraApi.failed("update", "Jira returned HTTP 403.") : undefined,
      );
      const api = yield* denied.api;
      expect(
        (yield* api.update!({ ...target, body: "legacy", richBody }).pipe(Effect.flip)).detail,
      ).toContain("403");
      expect(
        (yield* api.editComment!({ ...target, body: "legacy", commentId: "c1", richBody }).pipe(
          Effect.flip,
        )).detail,
      ).toContain("403");
      expect(denied.calls.filter((call) => call.method === "GET")).toHaveLength(3);
      const foreign = fixture((path) =>
        path.startsWith("/issue/ENG-1?")
          ? { ...issue, fields: { ...issue.fields, project: { id: "30", key: "OTHER" } } }
          : undefined,
      );
      const other = yield* foreign.api;
      yield* other.update!({ ...target, body: "legacy", richBody }).pipe(Effect.flip);
      yield* other.editComment!({ ...target, body: "legacy", commentId: "c1", richBody }).pipe(
        Effect.flip,
      );
      yield* other.setState!({
        ...target,
        state: "3",
        transitionId: "finish",
        fieldValues: { resolution: "fixed" },
      }).pipe(Effect.flip);
      expect(foreign.calls).toHaveLength(3);
      expect(
        foreign.calls.every(
          (call) => call.method === "GET" && call.path.startsWith("/issue/ENG-1?"),
        ),
      ).toBe(true);
    }),
);

it.effect.each(["cloud", "data-center"] as const)(
  "writes native Environment values on create and transition for %s",
  (deployment) =>
    Effect.gen(function* () {
      const environment = {
        fieldId: "environment",
        name: "Environment",
        required: true,
        schema: { type: "string", system: "environment" },
      };
      const f = fixture((path) => {
        if (path.includes("/issuetypes/task?"))
          return { startAt: 0, total: 2, fields: [fields[0], environment] };
        if (path.includes("/transitions?"))
          return { transitions: [{ id: "advance", to: status, fields: { environment } }] };
        if (path === "/search/jql") return { issues: [] };
        return undefined;
      }, deployment);
      const api = yield* f.api;
      const candidates = yield* api.listCandidates!({ ...target, issueType: "task" });
      expect(candidates.fields).toEqual([
        { id: "environment", label: "Environment", required: true, kind: "textarea" },
      ]);
      expect(candidates.states?.[0]?.fields).toEqual(candidates.fields);
      yield* api.create!({ ...create, fieldValues: { environment: "UAT" } });
      yield* api.setState!({
        ...target,
        state: status.id,
        transitionId: "advance",
        fieldValues: { environment: "UAT" },
      });
      const nativeEnvironment =
        deployment === "cloud"
          ? {
              type: "doc",
              version: 1,
              content: [{ type: "paragraph", content: [{ type: "text", text: "UAT" }] }],
            }
          : "UAT";
      expect(
        f.calls.find((call) => call.path === "/issue" && call.method === "POST")?.body,
      ).toEqual({
        fields: {
          project: { key: "ENG" },
          issuetype: { id: "task" },
          summary: "New",
          environment: nativeEnvironment,
        },
      });
      expect(f.calls.at(-1)?.body).toEqual({
        transition: { id: "advance" },
        fields: { environment: nativeEnvironment },
      });
    }),
);

it.effect.each([
  { type: "heading", content: [{ type: "text", text: "Missing level" }] },
  { type: "heading", attrs: { level: 7 }, content: [{ type: "text", text: "Bad level" }] },
  {
    type: "paragraph",
    content: [{ type: "text", text: "Mixed marks", marks: [{ type: "code" }, { type: "strong" }] }],
  },
])("rejects invalid native rich saves before issue or comment mutation: %j", (node) =>
  Effect.gen(function* () {
    const f = fixture();
    const api = yield* f.api;
    const richBody = {
      format: "adf" as const,
      document: JSON.stringify({ type: "doc", version: 1, content: [node] }),
    };
    yield* api.update!({ ...target, body: "legacy", richBody }).pipe(Effect.flip);
    yield* api.editComment!({ ...target, commentId: "c1", body: "legacy", richBody }).pipe(
      Effect.flip,
    );
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  }),
);

const wiki =
  "h1. Native wiki\r\n\r\n{panel:title=Status}*Ready*{panel}\r\n!diagram.png|width=320!\r\n[spec.pdf^spec.pdf]  ";
it.effect.each([wiki, wiki.replace("*Ready*", "*Changed*")])(
  "round trips DC wiki descriptions and comments verbatim: %s",
  (next) =>
    Effect.gen(function* () {
      const f = fixture((path) => {
        if (path.startsWith("/issue/ENG-1?"))
          return {
            ...issue,
            fields: {
              ...issue.fields,
              description: wiki,
              comment: { total: 1, comments: [{ ...comment, body: wiki }] },
            },
          };
        if (path.endsWith("/comment/c1")) return { ...comment, body: wiki };
        if (path.includes("/mypermissions?"))
          return {
            permissions: {
              EDIT_ISSUES: { havePermission: true },
              EDIT_OWN_COMMENTS: { havePermission: true },
            },
          };
        return undefined;
      }, "data-center");
      const api = yield* f.api;
      const detail = yield* api.getIssue(target);
      expect(detail.bodyEditable).toBe(false);
      expect(detail.capabilities).toMatchObject({ richText: true, updateParent: false });
      expect(detail.richBody).toEqual({ format: "jira-wiki", document: wiki });
      expect(detail.comments[0]).toMatchObject({
        canEdit: true,
        richBody: { format: "jira-wiki", document: wiki },
      });
      f.calls.length = 0;
      const richBody = { format: "jira-wiki" as const, document: next };
      yield* api.update!({ ...target, body: "plain fallback must not be used", richBody });
      yield* api.editComment!({
        ...target,
        commentId: "c1",
        body: "plain fallback must not be used",
        richBody,
      });
      expect(f.calls.map(({ method }) => method)).toEqual(["GET", "PUT", "GET", "GET", "PUT"]);
      expect(f.calls.filter(({ method }) => method === "PUT").map(({ body }) => body)).toEqual([
        { fields: { description: next } },
        { body: next },
      ]);
    }),
);
it.effect.each([
  { deployment: "cloud" as const, richBody: { format: "jira-wiki" as const, document: wiki } },
  {
    deployment: "data-center" as const,
    richBody: { format: "adf" as const, document: JSON.stringify(document) },
  },
  {
    deployment: "data-center" as const,
    richBody: { format: "jira-wiki" as const, document: "x".repeat(65_537) },
  },
])(
  "refuses wrong-deployment or oversized wiki saves before mutation: %j",
  ({ deployment, richBody }) =>
    Effect.gen(function* () {
      const f = fixture(
        (path) =>
          path.startsWith("/issue/ENG-1?") && deployment === "data-center"
            ? { ...issue, fields: { ...issue.fields, description: wiki } }
            : path.endsWith("/comment/c1") && deployment === "data-center"
              ? { ...comment, body: wiki }
              : undefined,
        deployment,
      );
      const api = yield* f.api;
      yield* api.update!({ ...target, body: "fallback", richBody }).pipe(Effect.flip);
      yield* api.editComment!({ ...target, commentId: "c1", body: "fallback", richBody }).pipe(
        Effect.flip,
      );
      expect(f.calls.map(({ method }) => method)).toEqual(["GET", "GET", "GET"]);
    }),
);
it.effect("keeps DC plain-body writes blocked and refuses blank wiki comments", () =>
  Effect.gen(function* () {
    const f = fixture(
      (path) =>
        path.startsWith("/issue/ENG-1?")
          ? { ...issue, fields: { ...issue.fields, description: wiki } }
          : path.endsWith("/comment/c1")
            ? { ...comment, body: wiki }
            : undefined,
      "data-center",
    );
    const api = yield* f.api;
    yield* api.update!({ ...target, body: "plain overwrite" }).pipe(Effect.flip);
    yield* api.editComment!({ ...target, commentId: "c1", body: "plain overwrite" }).pipe(
      Effect.flip,
    );
    for (const text of ["", " \r\n\t"])
      yield* api.editComment!({
        ...target,
        commentId: "c1",
        body: "fallback",
        richBody: { format: "jira-wiki", document: text },
      }).pipe(Effect.flip);
    expect(f.calls.every(({ method }) => method === "GET")).toBe(true);
    yield* api.update!({ ...target, richBody: { format: "jira-wiki", document: "" } });
    expect(f.calls.at(-1)?.body).toEqual({ fields: { description: "" } });
  }),
);

it.effect.each([
  { original: wiki, next: wiki },
  { original: wiki, next: wiki.replace("*Ready*", "*Changed*") },
  { original: null, next: wiki },
])("writes wiki source through the real DC adapter without conversion: %j", ({ original, next }) =>
  Effect.gen(function* () {
    const site = "https://jira.example.test:8443/Team/Jira";
    const host = "jira.example.test:8443/Team/Jira";
    const packed = JSON.stringify({ deployment: "data-center", site, token: "fake-pat" });
    const calls: HttpClientRequest.HttpClientRequest[] = [];
    const payloads: unknown[] = [];
    let permitted = true;
    let applied = 0;
    const http = HttpClient.make((request) => {
      calls.push(request);
      const commentRequest = new URL(request.url).pathname.endsWith("/comment/c1");
      if (request.method === "PUT" && !permitted)
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(null, { status: 403 })),
        );
      if (request.method === "PUT") {
        if (request.body._tag !== "Uint8Array") throw new Error("Expected native JSON body.");
        payloads.push(JSON.parse(new TextDecoder().decode(request.body.body)));
        applied++;
      }
      const path = new URL(request.url).pathname;
      const raw = path.endsWith("/myself")
        ? { key: "me", name: "ada" }
        : path.endsWith("/mypermissions")
          ? { permissions: { EDIT_ISSUES: { havePermission: true } } }
          : path.endsWith("/remotelink")
            ? []
            : commentRequest
              ? { ...comment, body: wiki, author: { key: "me", name: "ada" } }
              : { ...issue, fields: { ...issue.fields, description: original } };
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          request.method === "PUT" && !commentRequest
            ? new Response(null, { status: 204 })
            : new Response(JSON.stringify(raw)),
        ),
      );
    });
    const transport = JiraApi.make.pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.provideService(
        IssueTrackerHost,
        IssueTrackerHost.of({ credentials: { get: () => Effect.succeedSome(packed) } }),
      ),
      Effect.provide(SourceControlRateLimit.layer),
      Effect.provideService(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (size) => new Uint8Array(size),
          digest: (_algorithm, data) => Effect.succeed(data),
        }),
      ),
    );
    const api = yield* JiraIssueTracker.make.pipe(
      Effect.provideServiceEffect(JiraApi.JiraApi, transport),
    );
    const selected = { ...target, host };
    const richBody = { format: "jira-wiki" as const, document: next };
    if (original === null) {
      const detail = yield* api.getIssue(selected);
      expect(detail).toMatchObject({
        body: "",
        bodyEditable: false,
        viewerPermissions: { edit: true },
        richBody: { format: "jira-wiki", document: "" },
      });
      expect(calls).toHaveLength(4);
      calls.length = 0;
      yield* api.update!({ ...selected, body: "legacy overwrite" }).pipe(Effect.flip);
      yield* api.update!({
        ...selected,
        richBody: { format: "adf", document: JSON.stringify(document) },
      }).pipe(Effect.flip);
      yield* api.update!({
        ...selected,
        richBody: { format: "jira-wiki", document: "x".repeat(65_537) },
      }).pipe(Effect.flip);
      expect(calls.map(({ method }) => method)).toEqual(["GET", "GET", "GET"]);
      expect(applied).toBe(0);
      calls.length = 0;
    }
    yield* api.update!({ ...selected, richBody });
    yield* api.editComment!({ ...selected, commentId: "c1", body: "unused fallback", richBody });
    expect(payloads).toEqual([{ fields: { description: next } }, { body: next }]);
    expect(calls.map(({ method }) => method)).toEqual(["GET", "PUT", "GET", "GET", "PUT"]);
    expect(calls.filter(({ method }) => method === "PUT").map(({ url }) => url)).toEqual([
      `${site}/rest/api/2/issue/ENG-1`,
      `${site}/rest/api/2/issue/ENG-1/comment/c1`,
    ]);
    expect(calls.every(({ headers }) => headers.authorization === "Bearer fake-pat")).toBe(true);
    permitted = false;
    yield* api.update!({ ...selected, richBody }).pipe(Effect.flip);
    yield* api.editComment!({
      ...selected,
      commentId: "c1",
      body: "unused fallback",
      richBody,
    }).pipe(Effect.flip);
    expect(applied).toBe(2);
    expect(calls.map(({ method }) => method)).toEqual([
      "GET",
      "PUT",
      "GET",
      "GET",
      "PUT",
      "GET",
      "PUT",
      "GET",
      "GET",
      "PUT",
    ]);
  }),
);

it.effect(
  "keeps wiki source and native edit rights on older comment pages without extra HTTP",
  () =>
    Effect.gen(function* () {
      const f = fixture(
        (path) =>
          path.startsWith("/issue/ENG-1/comment?")
            ? { startAt: 0, total: 1, comments: [{ ...comment, body: wiki }] }
            : path.includes("/mypermissions?")
              ? { permissions: { EDIT_OWN_COMMENTS: { havePermission: true } } }
              : undefined,
        "data-center",
      );
      const page = yield* (yield* f.api).getComments({ ...target, viewer: "me" });
      expect(page.comments[0]).toMatchObject({
        body: wiki,
        richBody: { format: "jira-wiki", document: wiki },
        canEdit: true,
      });
      expect(page.nextCursor).toBeNull();
      expect(f.calls).toHaveLength(3);
      expect(f.calls.every(({ method }) => method === "GET")).toBe(true);
    }),
);

it.effect.each(["textColor", "subsup"])(
  "rejects marked code blocks before native HTTP writes: %s",
  (type) =>
    Effect.gen(function* () {
      const calls: HttpClientRequest.HttpClientRequest[] = [];
      const http = HttpClient.make((request) => {
        calls.push(request);
        const raw = request.url.endsWith("/comment/c1") ? comment : issue;
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(JSON.stringify(raw))),
        );
      });
      const transport = JiraApi.make.pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provideService(
          IssueTrackerHost,
          IssueTrackerHost.of({
            credentials: {
              get: () =>
                Effect.succeedSome(
                  JSON.stringify({
                    site: target.host,
                    email: "ada@example.test",
                    token: "fake-token",
                  }),
                ),
            },
          }),
        ),
        Effect.provide(SourceControlRateLimit.layer),
        Effect.provideService(
          Crypto.Crypto,
          Crypto.make({
            randomBytes: (size) => new Uint8Array(size),
            digest: (_algorithm, data) => Effect.succeed(data),
          }),
        ),
      );
      const api = yield* JiraIssueTracker.make.pipe(
        Effect.provideServiceEffect(JiraApi.JiraApi, transport),
      );
      const richBody = {
        format: "adf" as const,
        document: JSON.stringify({
          type: "doc",
          version: 1,
          content: [
            {
              type: "codeBlock",
              content: [
                {
                  type: "text",
                  text: "code",
                  marks: [{ type, attrs: { color: "#ff0000", type: "sub" } }],
                },
              ],
            },
          ],
        }),
      };
      yield* api.update!({ ...target, richBody }).pipe(Effect.flip);
      yield* api.editComment!({ ...target, commentId: "c1", body: "fallback", richBody }).pipe(
        Effect.flip,
      );
      expect(calls.map(({ method }) => method)).toEqual(["GET", "GET", "GET"]);
    }),
);

it.effect.each(["textColor", "subsup"])(
  "keeps serialized marked ADF as plain create text instead of a native code block: %s",
  (type) =>
    Effect.gen(function* () {
      const body = JSON.stringify({
        type: "doc",
        version: 1,
        content: [
          { type: "codeBlock", content: [{ type: "text", text: "code", marks: [{ type }] }] },
        ],
      });
      const f = fixture((path) =>
        path.includes("/issuetypes/task?")
          ? {
              startAt: 0,
              total: 2,
              fields: [
                fields[0],
                { fieldId: "description", schema: { type: "string", system: "description" } },
              ],
            }
          : undefined,
      );
      yield* (yield* f.api).create!({ ...create, body });
      expect(f.calls.at(-1)?.body).toEqual({
        fields: {
          project: { key: "ENG" },
          issuetype: { id: "task" },
          summary: "New",
          description: {
            type: "doc",
            version: 1,
            content: [{ type: "paragraph", content: [{ type: "text", text: body }] }],
          },
        },
      });
      expect(f.calls.map(({ method }) => method)).toEqual(["GET", "GET", "POST"]);
    }),
);
