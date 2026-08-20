import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { IssueAction, type IssueInvolvement, type IssueListState } from "@t3tools/contracts";

import * as AzureDevOpsCli from "../sourceControl/AzureDevOpsCli.ts";
import {
  decodeWorkItemJson,
  decodeWorkItemsJson,
  type AzureDevOpsWorkItem,
} from "./azureDevOpsIssueJson.ts";
import type { ProviderListCursor } from "./IssueProvider.ts";

/**
 * Names the read that produced unusable output, so a failure reports the call it came from
 * rather than borrowing another operation's message.
 */
export class AzureDevOpsIssueReadError extends Schema.TaggedErrorClass<AzureDevOpsIssueReadError>()(
  "AzureDevOpsIssueReadError",
  {
    command: Schema.Literal("az"),
    cwd: Schema.String,
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return `Azure CLI returned an unreadable ${this.operation} response.`;
  }

  override get message(): string {
    return `Azure CLI failed in ${this.operation}: ${this.detail}`;
  }
}

/** Not a decode failure: az answered with a work item that carries no title, date or link. */
export class AzureDevOpsWorkItemIncompleteError extends Schema.TaggedErrorClass<AzureDevOpsWorkItemIncompleteError>()(
  "AzureDevOpsWorkItemIncompleteError",
  {
    command: Schema.Literal("az"),
    cwd: Schema.String,
    number: Schema.Int,
  },
) {
  get detail(): string {
    return "Azure DevOps returned a work item with no title, date or link.";
  }

  override get message(): string {
    return `Azure CLI failed in getWorkItem: ${this.detail}`;
  }
}

/** Not a decode failure either: az answered, and named no project for the checkout it ran in. */
export class AzureDevOpsProjectUnknownError extends Schema.TaggedErrorClass<AzureDevOpsProjectUnknownError>()(
  "AzureDevOpsProjectUnknownError",
  {
    command: Schema.Literal("az"),
    cwd: Schema.String,
  },
) {
  get detail(): string {
    return "Azure DevOps named no project for this checkout.";
  }

  override get message(): string {
    return `Azure CLI failed in resolveProject: ${this.detail}`;
  }
}

/**
 * Every state Azure refused for one action. Nothing in `az boards` reads a project's workflow, so
 * the names that were attempted travel with the refusal: a process template that spells its states
 * some other way is the one explanation a bare command failure cannot give, and the list says
 * exactly which name such a project would have to add.
 */
export class AzureDevOpsWorkItemStateRefusedError extends Schema.TaggedErrorClass<AzureDevOpsWorkItemStateRefusedError>()(
  "AzureDevOpsWorkItemStateRefusedError",
  {
    command: Schema.Literal("az"),
    cwd: Schema.String,
    number: Schema.Int,
    action: IssueAction,
    states: Schema.Array(Schema.String),
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return `Azure DevOps refused every state that would ${this.action} work item ${this.number}: ${this.states.join(", ")}. Those are the states the out-of-the-box process templates use, and az reads no project's own workflow.`;
  }

  override get message(): string {
    return `Azure CLI failed in runWorkItemAction: ${this.detail}`;
  }
}

export type AzureDevOpsIssueCliError =
  | AzureDevOpsCli.AzureDevOpsCliError
  | AzureDevOpsIssueReadError
  | AzureDevOpsProjectUnknownError
  | AzureDevOpsWorkItemIncompleteError
  | AzureDevOpsWorkItemStateRefusedError;

/**
 * Involvement as Azure can answer it. `mentioned` is left out rather than answered unnarrowed:
 * Azure records no mention of a person on a work item, so the only page this could hand back is
 * the whole project — and nothing between here and the reader narrows it back down.
 */
export type AzureDevOpsInvolvement = Exclude<IssueInvolvement, "mentioned">;

export class AzureDevOpsIssueCli extends Context.Service<
  AzureDevOpsIssueCli,
  {
    readonly getViewer: (input: {
      readonly cwd: string;
    }) => Effect.Effect<string, AzureDevOpsIssueCliError>;
    readonly listWorkItems: (input: {
      readonly cwd: string;
      readonly state: IssueListState;
      /** No `mentioned`: Azure records none, and the provider refuses that filter before here. */
      readonly involvement: AzureDevOpsInvolvement;
      readonly limit: number;
      readonly cursor?: ProviderListCursor | undefined;
    }) => Effect.Effect<
      { readonly items: ReadonlyArray<AzureDevOpsWorkItem>; readonly truncated: boolean },
      AzureDevOpsIssueCliError
    >;
    readonly getWorkItem: (input: {
      readonly cwd: string;
      readonly number: number;
    }) => Effect.Effect<AzureDevOpsWorkItem, AzureDevOpsIssueCliError>;
    readonly runWorkItemAction: (input: {
      readonly cwd: string;
      readonly number: number;
      readonly action: IssueAction;
    }) => Effect.Effect<void, AzureDevOpsIssueCliError>;
  }
>()("t3/issue/AzureDevOpsIssueCli") {}

/**
 * The states a work item is moved into, written in order until Azure accepts one. Azure has no
 * close or reopen verb — a state is written like any other field — and `az boards` has no command
 * that reads a project's workflow. This is not discovery, then: it is a walk through the names
 * Microsoft documents for the four out-of-the-box process templates, Agile and CMMI first so those
 * projects still cost exactly one write.
 *
 * Closing: `Closed` on Agile and CMMI, `Done` on Scrum and Basic. Reopening: `Active` on Agile and
 * CMMI, `Committed` for Scrum's backlog items and `To Do` for its tasks, `Doing` on Basic — with
 * `New` and `Proposed` behind them for a workflow that allows no transition straight back into
 * work. A custom template can refuse all of them, and the refusal then names every one tried.
 */
const ACTION_STATES: Record<IssueAction, readonly [string, ...ReadonlyArray<string>]> = {
  close: ["Closed", "Done"],
  reopen: ["Active", "Committed", "Doing", "To Do", "New", "Proposed"],
};

/**
 * How often a listing doubles the window it asks Azure for when rows come back unreadable. Three
 * is where it stops: past a block of eight pages of rows this cannot place, the listing hands over
 * what it has and reports no more — a short list rather than a walk that never ends.
 */
const MAX_LIST_WIDENINGS = 3;

/** WIQL has one quote to escape, and a title filter never reaches it — but a cursor does. */
const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`;

function involvementClause(involvement: AzureDevOpsInvolvement): string {
  switch (involvement) {
    case "assigned":
      return " AND [System.AssignedTo] = @Me";
    case "authored":
      return " AND [System.CreatedBy] = @Me";
    case "all":
      return "";
  }
}

/**
 * The names the decoder reads as closed, spelled the way Azure stores them. The two lists are one
 * decision: a state named here and not there — or the other way round — puts a work item in the
 * open list and then shows it as closed.
 */
function stateClause(state: IssueListState): string {
  switch (state) {
    case "open":
      return " AND [System.State] NOT IN ('Closed', 'Completed', 'Done', 'Removed', 'Resolved')";
    case "closed":
      return " AND [System.State] IN ('Closed', 'Completed', 'Done', 'Removed', 'Resolved')";
    case "all":
      return "";
  }
}

export const make = Effect.gen(function* () {
  const azure = yield* AzureDevOpsCli.AzureDevOpsCli;

  // Every command resolves the organization and project from the checkout, which is what the
  // rest of the Azure wrapper does: the remote takes three shapes and only `az` reads all of them.
  const detectArgs = ["--detect", "true"] as const;

  const executeJson = (input: { readonly cwd: string; readonly args: ReadonlyArray<string> }) =>
    azure.execute({
      cwd: input.cwd,
      args: [...input.args, "--only-show-errors", "--output", "json"],
    });

  const read = <A>(input: {
    readonly cwd: string;
    readonly operation: string;
    readonly args: ReadonlyArray<string>;
    readonly decode: (raw: string) => Result.Result<A, unknown>;
  }) =>
    executeJson({ cwd: input.cwd, args: input.args }).pipe(
      Effect.flatMap((result) => {
        const decoded = input.decode(result.stdout);
        return Result.isSuccess(decoded)
          ? Effect.succeed(decoded.success)
          : Effect.fail(
              new AzureDevOpsIssueReadError({
                command: "az",
                cwd: input.cwd,
                operation: input.operation,
                cause: decoded.failure,
              }),
            );
      }),
    );

  /**
   * The project the checkout belongs to, named rather than left to WIQL's `@project` macro:
   * `az boards query` runs at the organization, and never forwards a project to the query it
   * sends — so `@project` resolves to nothing and the answer spans every project in the
   * organization. Read from the repository the checkout points at, which is where `az` already
   * looks for everything else.
   */
  const projectName = (cwd: string) =>
    azure
      .execute({
        cwd,
        args: [
          "repos",
          "show",
          ...detectArgs,
          "--query",
          "project.name",
          "--only-show-errors",
          "--output",
          "tsv",
        ],
      })
      .pipe(
        Effect.flatMap((result) => {
          const name = result.stdout.trim();
          if (name.length > 0) return Effect.succeed(name);
          return Effect.fail(new AzureDevOpsProjectUnknownError({ command: "az", cwd }));
        }),
      );

  return AzureDevOpsIssueCli.of({
    getViewer: (input) =>
      read({
        cwd: input.cwd,
        operation: "getViewer",
        args: ["account", "show", "--query", "user.name"],
        decode: (raw) => Result.succeed(raw.trim().replaceAll('"', "")),
      }),

    listWorkItems: (input) => {
      // Asked for one row beyond the page, which is how every provider here probes for a next
      // slice without a second request.
      const wanted = input.limit + 1;
      const cursorClause =
        input.cursor === undefined
          ? ""
          : ` AND [System.ChangedDate] <= ${quoted(input.cursor.updatedBefore)}`;
      const query = (project: string, top: number) =>
        read({
          cwd: input.cwd,
          operation: "listWorkItems",
          // The query travels as one argv value rather than through a shell, and carries no
          // text the reader typed: Azure filters by no free text, so a search never reaches it.
          args: [
            "boards",
            "query",
            ...detectArgs,
            "--wiql",
            `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = ${quoted(project)}` +
              stateClause(input.state) +
              involvementClause(input.involvement) +
              cursorClause +
              " ORDER BY [System.ChangedDate] DESC",
            "--top",
            String(top),
          ],
          decode: decodeWorkItemsJson,
        });

      /**
       * A window wide enough to fill the page with rows this can read. `--top` bounds the window
       * in rows Azure counted, not in rows this decoded, and the cursor can only carry on from a
       * row it decoded — so a window whose tail is rows this cannot place would be asked for
       * again, unchanged, on every following page. Widening steps over them instead.
       */
      const fill = (
        project: string,
        top: number,
        widenings: number,
      ): Effect.Effect<
        { readonly items: ReadonlyArray<AzureDevOpsWorkItem>; readonly rawCount: number },
        AzureDevOpsIssueCliError
      > =>
        query(project, top).pipe(
          Effect.flatMap((page) =>
            page.items.length >= wanted || page.rawCount < top || widenings === MAX_LIST_WIDENINGS
              ? Effect.succeed(page)
              : fill(project, top * 2, widenings + 1),
          ),
        );

      return projectName(input.cwd).pipe(
        Effect.flatMap((project) => fill(project, wanted, 0)),
        Effect.map((page) => ({
          items: page.items.slice(0, input.limit),
          // Counted in rows this could read. A page that reports more without leaving a readable
          // row to carry on from is one the reader asks for again from the same place, forever.
          truncated: page.items.length > input.limit,
        })),
      );
    },

    getWorkItem: (input) =>
      read({
        cwd: input.cwd,
        operation: "getWorkItem",
        args: ["boards", "work-item", "show", "--id", String(input.number)],
        decode: decodeWorkItemJson,
      }).pipe(
        Effect.flatMap((item) =>
          item === null
            ? Effect.fail(
                new AzureDevOpsWorkItemIncompleteError({
                  command: "az",
                  cwd: input.cwd,
                  number: input.number,
                }),
              )
            : Effect.succeed(item),
        ),
      ),

    runWorkItemAction: (input) => {
      const write = (
        state: string,
        remaining: ReadonlyArray<string>,
      ): Effect.Effect<void, AzureDevOpsIssueCliError> =>
        executeJson({
          cwd: input.cwd,
          args: ["boards", "work-item", "update", "--id", String(input.number), "--state", state],
        }).pipe(
          Effect.asVoid,
          // Only the failure az reports for a rule it broke moves on to the next name. An unusable
          // tool, an unauthenticated one and a work item that is not there arrive under their own
          // tags: they keep their own explanation, and no other state is written after them.
          Effect.catchTags({
            AzureDevOpsCommandFailedError: (error) => {
              const [next, ...following] = remaining;
              return next === undefined
                ? Effect.fail(
                    new AzureDevOpsWorkItemStateRefusedError({
                      command: "az",
                      cwd: input.cwd,
                      number: input.number,
                      action: input.action,
                      states: ACTION_STATES[input.action],
                      cause: error,
                    }),
                  )
                : write(next, following);
            },
          }),
        );

      const [first, ...rest] = ACTION_STATES[input.action];
      return write(first, rest);
    },
  });
});

export const layer = Layer.effect(AzureDevOpsIssueCli, make);
