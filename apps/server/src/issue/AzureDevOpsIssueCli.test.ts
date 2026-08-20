import { afterEach, assert, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as AzureDevOpsCli from "../sourceControl/AzureDevOpsCli.ts";
import * as AzureDevOpsIssueCli from "./AzureDevOpsIssueCli.ts";
import * as AzureDevOpsIssueProvider from "./AzureDevOpsIssueProvider.ts";

const mockedExecute = vi.fn<AzureDevOpsCli.AzureDevOpsCli["Service"]["execute"]>();

const layer = it.layer(
  AzureDevOpsIssueCli.layer.pipe(
    Layer.provide(Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({ execute: mockedExecute })),
  ),
);

function output(stdout: string) {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function workItem(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    url: `https://dev.azure.com/acme/_apis/wit/workItems/${id}`,
    fields: {
      "System.Title": `Work item ${id}`,
      "System.State": "Active",
      "System.CreatedDate": "2026-07-01T00:00:00Z",
      "System.ChangedDate": "2026-07-02T00:00:00Z",
      ...overrides,
    },
  };
}

/** Answers the project lookup every listing makes first, then the query itself. */
function listing(items: ReadonlyArray<unknown>, project = "web") {
  mockedExecute.mockImplementation(
    (input) =>
      Effect.succeed(
        output(input.args[0] === "repos" ? `${project}\n` : JSON.stringify(items)),
      ) as ReturnType<AzureDevOpsCli.AzureDevOpsCli["Service"]["execute"]>,
  );
}

/** The same, with one answer per query it makes — the last one for every query after those. */
function listings(pages: ReadonlyArray<ReadonlyArray<unknown>>, project = "web") {
  let asked = 0;
  mockedExecute.mockImplementation((input) => {
    if (input.args[0] === "repos") {
      return Effect.succeed(output(`${project}\n`)) as ReturnType<
        AzureDevOpsCli.AzureDevOpsCli["Service"]["execute"]
      >;
    }
    const page = pages[Math.min(asked, pages.length - 1)] ?? [];
    asked += 1;
    return Effect.succeed(output(JSON.stringify(page))) as ReturnType<
      AzureDevOpsCli.AzureDevOpsCli["Service"]["execute"]
    >;
  });
}

/** A row Azure counted and this cannot place: no link, no title, no dates. */
const unreadable = (id: number) => ({ id, url: null, fields: null });

/** A project of nothing but those, always as many rows as the query asked for. */
function unreadableListing(project = "web") {
  mockedExecute.mockImplementation((input) => {
    if (input.args[0] === "repos") {
      return Effect.succeed(output(`${project}\n`)) as ReturnType<
        AzureDevOpsCli.AzureDevOpsCli["Service"]["execute"]
      >;
    }
    const top = Number(input.args[input.args.indexOf("--top") + 1]);
    return Effect.succeed(
      output(JSON.stringify(Array.from({ length: top }, (_, index) => unreadable(index + 1)))),
    ) as ReturnType<AzureDevOpsCli.AzureDevOpsCli["Service"]["execute"]>;
  });
}

/** The one rule error az reports for a state a project's workflow does not have. */
const ruleError = (argumentCount: number) =>
  new AzureDevOpsCli.AzureDevOpsCommandFailedError({
    operation: "execute",
    command: "az",
    cwd: "/w",
    argumentCount,
    cause: new Error("TF401320: Rule Error for field State."),
  });

/** A project whose workflow has only the states named: every other write is refused. */
function acceptsStates(...accepted: ReadonlyArray<string>) {
  mockedExecute.mockImplementation((input) => {
    const state = input.args[input.args.indexOf("--state") + 1] ?? "";
    return (
      accepted.includes(state)
        ? Effect.succeed(output("{}"))
        : Effect.fail(ruleError(input.args.length))
    ) as ReturnType<AzureDevOpsCli.AzureDevOpsCli["Service"]["execute"]>;
  });
}

const updateArgs = (state: string) => [
  "boards",
  "work-item",
  "update",
  "--id",
  "7",
  "--state",
  state,
  "--only-show-errors",
  "--output",
  "json",
];

const statesWritten = () =>
  mockedExecute.mock.calls.map(([input]) => input.args[input.args.indexOf("--state") + 1]);

const topsOf = () =>
  mockedExecute.mock.calls
    .filter(([input]) => input.args[0] === "boards")
    .map(([input]) => input.args[input.args.indexOf("--top") + 1]);

const wiqlOf = () => {
  const call = mockedExecute.mock.calls.find(([input]) => input.args[0] === "boards");
  assert.isDefined(call);
  const args = call[0].args;
  return args[args.indexOf("--wiql") + 1] ?? "";
};

afterEach(() => {
  mockedExecute.mockReset();
});

layer((it) => {
  it.effect("names the project in the query, because az boards runs at the organization", () =>
    Effect.gen(function* () {
      listing([workItem(1)], "Fabrikam Web");
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;

      yield* cli.listWorkItems({ cwd: "/w", state: "open", involvement: "all", limit: 30 });

      // `@project` resolves to nothing here, so the query would otherwise answer for every
      // project in the organization.
      expect(wiqlOf()).toContain("[System.TeamProject] = 'Fabrikam Web'");
      expect(wiqlOf()).not.toContain("@project");
    }),
  );

  it.effect("asks az for the project the checkout belongs to", () =>
    Effect.gen(function* () {
      listing([]);
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;

      yield* cli.listWorkItems({ cwd: "/w", state: "all", involvement: "all", limit: 30 });

      expect(mockedExecute.mock.calls[0]?.[0].args).toEqual([
        "repos",
        "show",
        "--detect",
        "true",
        "--query",
        "project.name",
        "--only-show-errors",
        "--output",
        "tsv",
      ]);
    }),
  );

  it.effect("fails rather than answering the whole organization when az names no project", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation(
        () =>
          Effect.succeed(output("  \n")) as ReturnType<
            AzureDevOpsCli.AzureDevOpsCli["Service"]["execute"]
          >,
      );
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;

      const error = yield* Effect.flip(
        cli.listWorkItems({ cwd: "/w", state: "open", involvement: "all", limit: 30 }),
      );

      assert.strictEqual(error._tag, "AzureDevOpsProjectUnknownError");
      // az itself succeeded, so there is no underlying failure to report as the cause.
      assert.isFalse("cause" in error);
      assert.strictEqual(
        error.message,
        "Azure CLI failed in resolveProject: Azure DevOps named no project for this checkout.",
      );
    }),
  );

  it.effect("says what failed once, rather than stacking the same sentence twice", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation(
        (input) =>
          Effect.succeed(output(input.args[0] === "repos" ? "web\n" : "not json")) as ReturnType<
            AzureDevOpsCli.AzureDevOpsCli["Service"]["execute"]
          >,
      );
      const provider = yield* AzureDevOpsIssueProvider.make;

      const error = yield* Effect.flip(
        provider.listIssues({
          cwd: "/w",
          repository: "acme/web",
          host: "dev.azure.com",
          state: "all",
          involvement: "all",
          viewer: "someone",
          limit: 30,
        }),
      );

      assert.strictEqual(
        error.message,
        "azure-devops failed in listIssues: Azure CLI returned an unreadable listWorkItems response.",
      );
    }),
  );

  it.effect("narrows by state and by who a work item belongs to", () =>
    Effect.gen(function* () {
      listing([]);
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;

      yield* cli.listWorkItems({ cwd: "/w", state: "open", involvement: "assigned", limit: 30 });

      expect(wiqlOf()).toContain(
        "[System.State] NOT IN ('Closed', 'Completed', 'Done', 'Removed', 'Resolved')",
      );
      expect(wiqlOf()).toContain("[System.AssignedTo] = @Me");
    }),
  );

  it.effect("asks for the same closed states the decoder reads back as closed", () =>
    Effect.gen(function* () {
      listing([workItem(1, { "System.State": "Completed" })]);
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;

      const page = yield* cli.listWorkItems({
        cwd: "/w",
        state: "closed",
        involvement: "all",
        limit: 30,
      });

      expect(wiqlOf()).toContain(
        "[System.State] IN ('Closed', 'Completed', 'Done', 'Removed', 'Resolved')",
      );
      // A state the query calls open and the decoder calls closed lands in the open list and is
      // then shown as closed there.
      assert.strictEqual(page.items[0]?.state, "closed");
    }),
  );

  it.effect("refuses a mention filter rather than answering with the whole project", () =>
    Effect.gen(function* () {
      listing([workItem(1)]);
      const provider = yield* AzureDevOpsIssueProvider.make;

      const error = yield* Effect.flip(
        provider.listIssues({
          cwd: "/w",
          repository: "acme/web",
          host: "dev.azure.com",
          state: "all",
          involvement: "mentioned",
          viewer: "someone",
          limit: 30,
        }),
      );

      assert.strictEqual(
        error.detail,
        "Azure DevOps records no mention of a person on a work item.",
      );
      // Azure was asked nothing, because there is no question here it could have answered.
      assert.strictEqual(mockedExecute.mock.calls.length, 0);
    }),
  );

  it.effect("carries on from the instant a cursor names, escaping the quote WIQL has", () =>
    Effect.gen(function* () {
      listing([]);
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;

      yield* cli.listWorkItems({
        cwd: "/w",
        state: "all",
        involvement: "all",
        limit: 30,
        cursor: { updatedBefore: "2026-07-02T00:00:00Z' OR [System.Id] > 0 --" },
      });

      expect(wiqlOf()).toContain(
        "[System.ChangedDate] <= '2026-07-02T00:00:00Z'' OR [System.Id] > 0 --'",
      );
    }),
  );

  it.effect("keeps the extra row it probed with out of the page it hands over", () =>
    Effect.gen(function* () {
      listing([workItem(1), workItem(2), workItem(3)]);
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;

      const page = yield* cli.listWorkItems({
        cwd: "/w",
        state: "all",
        involvement: "all",
        limit: 2,
      });

      assert.deepStrictEqual(
        page.items.map((item) => item.number),
        [1, 2],
      );
      assert.isTrue(page.truncated);
    }),
  );

  it.effect("skips a work item it cannot place rather than losing the page with it", () =>
    Effect.gen(function* () {
      listing([workItem(1), { id: 2, url: null, fields: null }, workItem(3)]);
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;

      const page = yield* cli.listWorkItems({
        cwd: "/w",
        state: "all",
        involvement: "all",
        limit: 30,
      });

      assert.deepStrictEqual(
        page.items.map((item) => item.number),
        [1, 3],
      );
    }),
  );

  it.effect("widens the window rather than paging on rows it cannot read", () =>
    Effect.gen(function* () {
      listings([
        [workItem(1), unreadable(2), unreadable(3)],
        [workItem(1), unreadable(2), unreadable(3), workItem(4), workItem(5), workItem(6)],
      ]);
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;

      const page = yield* cli.listWorkItems({
        cwd: "/w",
        state: "all",
        involvement: "all",
        limit: 2,
      });

      // `--top` counts rows Azure has, not rows this can read, so the unreadable tail would bound
      // every following page at the same place: the cursor carries on from work item 4 instead.
      assert.deepStrictEqual(topsOf(), ["3", "6"]);
      assert.deepStrictEqual(
        page.items.map((item) => item.number),
        [1, 4],
      );
      assert.isTrue(page.truncated);
    }),
  );

  it.effect("stops rather than reporting more with no row to carry on from", () =>
    Effect.gen(function* () {
      unreadableListing();
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;

      const page = yield* cli.listWorkItems({
        cwd: "/w",
        state: "all",
        involvement: "all",
        limit: 2,
      });

      assert.deepStrictEqual(page.items, []);
      // Reported as truncated, this page would be asked for again from the same instant forever.
      assert.isFalse(page.truncated);
      assert.deepStrictEqual(topsOf(), ["3", "6", "12", "24"]);
    }),
  );

  it.effect("asks once where Azure answered with rows it could read", () =>
    Effect.gen(function* () {
      listings([[workItem(1), workItem(2), workItem(3)]]);
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;

      yield* cli.listWorkItems({ cwd: "/w", state: "all", involvement: "all", limit: 2 });

      assert.deepStrictEqual(topsOf(), ["3"]);
    }),
  );

  it.effect("turns the api link into the board page a reader can actually open", () =>
    Effect.gen(function* () {
      listing([workItem(7)]);
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;

      const page = yield* cli.listWorkItems({
        cwd: "/w",
        state: "all",
        involvement: "all",
        limit: 30,
      });

      assert.strictEqual(page.items[0]?.url, "https://dev.azure.com/acme/_workitems/edit/7");
    }),
  );

  it.effect("reads a project's own closed states as closed", () =>
    Effect.gen(function* () {
      listing([workItem(1, { "System.State": "Done" }), workItem(2, { "System.State": "Doing" })]);
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;

      const page = yield* cli.listWorkItems({
        cwd: "/w",
        state: "all",
        involvement: "all",
        limit: 30,
      });

      assert.deepStrictEqual(
        page.items.map((item) => item.state),
        ["closed", "open"],
      );
    }),
  );

  it.effect("writes a state, which is all Azure has in place of closing and reopening", () =>
    Effect.gen(function* () {
      acceptsStates("Closed");
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;

      yield* cli.runWorkItemAction({ cwd: "/w", number: 7, action: "close" });

      // Agile and CMMI spell it `Closed`, and are asked first: those projects cost one write.
      assert.deepStrictEqual(
        mockedExecute.mock.calls.map(([input]) => input.args),
        [updateArgs("Closed")],
      );
    }),
  );

  it.effect("moves on to the name the next process template uses when Azure refuses one", () =>
    Effect.gen(function* () {
      acceptsStates("Done");
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;

      yield* cli.runWorkItemAction({ cwd: "/w", number: 7, action: "close" });

      // A Scrum or Basic project has no `Closed` state, and nothing in az boards says so: the
      // documented name it does have is written next.
      assert.deepStrictEqual(
        mockedExecute.mock.calls.map(([input]) => input.args),
        [updateArgs("Closed"), updateArgs("Done")],
      );
    }),
  );

  it.effect("names every state it tried, which a bare command failure does not", () =>
    Effect.gen(function* () {
      acceptsStates();
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;

      const error = yield* Effect.flip(
        cli.runWorkItemAction({ cwd: "/w", number: 7, action: "reopen" }),
      );

      // Every out-of-the-box name was refused, so this project runs a custom template: the list is
      // what tells its owner which state of their own belongs here.
      assert.strictEqual(error._tag, "AzureDevOpsWorkItemStateRefusedError");
      expect(error.message).toContain(
        "refused every state that would reopen work item 7: Active, Committed, Doing, To Do, New, Proposed",
      );
      assert.deepStrictEqual(statesWritten(), [
        "Active",
        "Committed",
        "Doing",
        "To Do",
        "New",
        "Proposed",
      ]);
    }),
  );

  it.effect("writes no second state where az answered that it is not signed in", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation(
        (input) =>
          Effect.fail(
            new AzureDevOpsCli.AzureDevOpsCliAuthenticationError({
              operation: "execute",
              command: "az",
              cwd: "/w",
              argumentCount: input.args.length,
              cause: new Error("az devops login"),
            }),
          ) as ReturnType<AzureDevOpsCli.AzureDevOpsCli["Service"]["execute"]>,
      );
      const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;

      const error = yield* Effect.flip(
        cli.runWorkItemAction({ cwd: "/w", number: 7, action: "close" }),
      );

      // Nothing about the state was wrong, so another name would fail the same way and bury the
      // one answer that tells the reader what to do.
      assert.strictEqual(error._tag, "AzureDevOpsCliAuthenticationError");
      assert.deepStrictEqual(statesWritten(), ["Closed"]);
    }),
  );
});
