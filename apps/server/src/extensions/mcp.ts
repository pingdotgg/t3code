import {
  ExtensionContentHash,
  ExtensionInvokeInput,
  ExtensionOperationError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpServer, Tool, Toolkit } from "effect/unstable/ai";
import { McpInvocationContext } from "../mcp/McpInvocationContext.ts";
import { catalogPage } from "./catalog.ts";
import { EnvironmentExtensions } from "./EnvironmentExtensions.ts";

const decodeJson = Schema.decodeUnknownEffect(Schema.Json);
const decodeInvocation = Schema.decodeUnknownEffect(ExtensionInvokeInput);

const dependencies = [McpInvocationContext, EnvironmentExtensions];
export const ExtensionsToolkit = Toolkit.make(
  Tool.make("extensions_list", {
    description:
      "List enabled read-only extension tools granted to this provider session's project. Use nextCursor to page until null, and each returned contentHash for extensions_call. Scope comes from this MCP credential.",
    parameters: Schema.Struct({
      cursor: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160))),
    }),
    success: Schema.Json,
    failure: ExtensionOperationError,
    dependencies,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("extensions_call", {
    description:
      "Call one installed read-only extension tool at the catalog contentHash. Environment, project, thread and workspace scope are derived from this MCP credential; caller-supplied context is never authority.",
    parameters: Schema.Struct({
      toolId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
      input: Schema.Json,
      expectedContentHash: ExtensionContentHash,
    }),
    success: Schema.Json,
    failure: ExtensionOperationError,
    dependencies,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
);
const invocationContext = Effect.fn("ExtensionsMcp.context")(function* () {
  const scope = yield* McpInvocationContext;
  if (!scope.capabilities.has("extensions"))
    return yield* new ExtensionOperationError({
      operation: "mcp",
      detail: "MCP credential lacks extension capability.",
    });
  const extensions = yield* EnvironmentExtensions;
  return yield* extensions.contextForThread(scope.threadId, scope.environmentId);
});
export const handlers = {
  extensions_list: Effect.fn("ExtensionsMcp.list")(function* (input: {
    readonly cursor?: string | undefined;
  }) {
    const extensions = yield* EnvironmentExtensions;
    const context = yield* invocationContext();
    const tools = yield* extensions.tools(context);
    const page = yield* Effect.try({
      try: () => catalogPage(tools, input.cursor),
      catch: () =>
        new ExtensionOperationError({
          operation: "mcp.list",
          detail: "Tool catalog descriptor exceeds its 64KiB page budget.",
        }),
    });
    return yield* decodeJson(page).pipe(
      Effect.mapError(
        () =>
          new ExtensionOperationError({
            operation: "mcp.list",
            detail: "Tool catalog is not valid JSON.",
          }),
      ),
    );
  }),
  extensions_call: Effect.fn("ExtensionsMcp.call")(function* (
    input: Pick<ExtensionInvokeInput, "toolId" | "input" | "expectedContentHash">,
  ) {
    const extensions = yield* EnvironmentExtensions;
    const context = yield* invocationContext();
    const tools = yield* extensions.tools(context);
    if (
      !tools.some(
        (tool) =>
          tool.descriptor.id === input.toolId && tool.contentHash === input.expectedContentHash,
      )
    )
      return yield* new ExtensionOperationError({
        operation: "mcp.call",
        detail: "Tool is unavailable, ungranted, or its installed content changed.",
      });
    const verified = yield* decodeInvocation({
      ...input,
      context,
    }).pipe(
      Effect.mapError(
        () =>
          new ExtensionOperationError({
            operation: "mcp.call",
            detail: "Derived extension context exceeds the supported contract bounds.",
          }),
      ),
    );
    return yield* extensions.invoke(verified);
  }),
} satisfies Parameters<typeof ExtensionsToolkit.toLayer>[0];
export const registrationLayer = McpServer.toolkit(ExtensionsToolkit).pipe(
  Layer.provide(ExtensionsToolkit.toLayer(handlers)),
);
