import { describe, expect, it } from "vite-plus/test";
import type { ViewContext } from "@t3tools/extension-sdk/contracts";
import { filesViewRecord, type FilesBindings } from "./filesExtension";

const context: ViewContext = {
  client: "web",
  workspaceRevision: "/workspace",
  resource: {
    namespace: "t3.workspace",
    id: "right-panel",
    environmentId: "env",
    projectId: "project",
    threadId: "first",
  },
};
// Record generation consumes only the surface; component props are irrelevant to this boundary.
const files = { surface: { kind: "files", id: "files" } } satisfies Pick<FilesBindings, "surface">;
describe("Files resource ownership", () => {
  it("keeps workspace presentation identity through thread navigation", () => {
    expect(filesViewRecord(files, context)).toEqual(
      filesViewRecord(files, {
        ...context,
        resource: { ...context.resource, threadId: "second" },
      }),
    );
    expect(filesViewRecord(files, context).context.resource.threadId).toBeUndefined();
  });
  it("separates environments and changed workspaces", () => {
    const first = filesViewRecord(files, context);
    expect(filesViewRecord(files, { ...context, workspaceRevision: "/other" })).not.toEqual(first);
    expect(
      filesViewRecord(files, {
        ...context,
        resource: { ...context.resource, environmentId: "other" },
      }),
    ).not.toEqual(first);
  });
});
