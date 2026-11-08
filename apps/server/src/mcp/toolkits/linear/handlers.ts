import * as Effect from "effect/Effect";
import { LinearService } from "../../../linear/LinearService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { LinearToolkit } from "./tools.ts";

const make = Effect.gen(function* () {
  const linear = yield* LinearService;
  const access = McpInvocationContext.requireMcpCapability("linear");
  return {
    linear_workspace: McpToolAccess.reads((_input) =>
      access.pipe(Effect.andThen(() => linear.workspace())),
    ),
    linear_team: McpToolAccess.reads((input) =>
      access.pipe(Effect.andThen(() => linear.teamContext(input))),
    ),
    linear_issues: McpToolAccess.reads((input) =>
      access.pipe(Effect.andThen(() => linear.issues(input))),
    ),
    linear_issue: McpToolAccess.reads((input) =>
      access.pipe(Effect.andThen(() => linear.issue(input))),
    ),
    linear_comments: McpToolAccess.reads((input) =>
      access.pipe(Effect.andThen(() => linear.comments(input))),
    ),
    linear_projects: McpToolAccess.reads((input) =>
      access.pipe(Effect.andThen(() => linear.projects(input))),
    ),
    linear_project: McpToolAccess.reads((input) =>
      access.pipe(Effect.andThen(() => linear.project(input))),
    ),
    linear_documents: McpToolAccess.reads((input) =>
      access.pipe(Effect.andThen(() => linear.documents(input))),
    ),
    linear_document: McpToolAccess.reads((input) =>
      access.pipe(Effect.andThen(() => linear.document(input))),
    ),
    linear_inbox: McpToolAccess.reads((input) =>
      access.pipe(Effect.andThen(() => linear.inbox(input))),
    ),
    linear_mutate: McpToolAccess.writesWithCapability(({ change }) =>
      access.pipe(Effect.andThen(() => linear.mutate(change))),
    ),
  } satisfies McpToolAccess.Handlers<typeof LinearToolkit.tools>;
});
export const layer = McpToolAccess.toLayer(LinearToolkit, make);
