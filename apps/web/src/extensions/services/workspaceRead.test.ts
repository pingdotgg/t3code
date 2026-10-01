import { describe, expect, it } from "vite-plus/test";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { copyJson, MAX_PAYLOAD_BYTES, type ViewContext } from "@t3tools/extension-sdk/contracts";
import { createExtensionHost, type Extension, type ServiceCall } from "@t3tools/extension-sdk/host";
import {
  boundedWorkspaceText,
  createWorkspaceReadService,
  resolveWorkspaceReadTarget,
  workspaceReadHostOptions,
  WORKSPACE_READ_TEXT,
} from "./workspaceRead";

const context: ViewContext = {
  client: "web",
  resource: {
    namespace: "example.workspace",
    id: "reader",
    environmentId: "env-a",
    projectId: "project",
  },
};
function call(input: ServiceCall["input"], signal = new AbortController().signal): ServiceCall {
  return {
    extensionId: "example.reader",
    surfaceId: "example.reader/view",
    context,
    input,
    signal,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe("trusted workspace read adapter", () => {
  it("derives project/worktree scope and rejects foreign thread membership", () => {
    const snapshot = {
      projects: [{ id: ProjectId.make("project"), workspaceRoot: "/owned/project" }],
      threads: [
        {
          id: ThreadId.make("thread"),
          projectId: ProjectId.make("project"),
          worktreePath: "/owned/worktree",
        },
        {
          id: ThreadId.make("foreign"),
          projectId: ProjectId.make("other"),
          worktreePath: "/other",
        },
      ],
    };
    expect(resolveWorkspaceReadTarget(snapshot, context).cwd).toBe("/owned/project");
    expect(
      resolveWorkspaceReadTarget(snapshot, {
        ...context,
        resource: { ...context.resource, threadId: "thread" },
      }).cwd,
    ).toBe("/owned/worktree");
    for (const threadId of ["foreign", "missing"])
      expect(() =>
        resolveWorkspaceReadTarget(snapshot, {
          ...context,
          resource: { ...context.resource, threadId },
        }),
      ).toThrow("Thread does not belong");
  });
  it("rejects path and scope overrides before backend I/O", async () => {
    let reads = 0;
    const service = createWorkspaceReadService({
      resolve: () => ({ cwd: "/owned", revision: "v1" }),
      read: async () => {
        reads++;
        throw new Error("Unexpected read");
      },
    });
    for (const relativePath of [
      "/etc/passwd",
      "../secret",
      "a/../secret",
      "C:/secret",
      "C:secret",
      "\\\\host\\share",
      "a\\b",
      "./readme",
      " a",
      "a//b",
      "a\u0000b",
    ]) {
      await expect(service.invoke(call({ relativePath }))).rejects.toThrow("workspace-relative");
    }
    await expect(service.invoke(call({ relativePath: "a", cwd: "/other" }))).rejects.toThrow();
    expect(reads).toBe(0);
  });
  it("uses the bound environment and contains stale or aborted results", async () => {
    let revision = "v1";
    const pending = deferred<{
      relativePath: string;
      contents: string;
      byteLength: number;
      truncated: boolean;
    }>();
    const seen: unknown[] = [];
    const service = createWorkspaceReadService({
      resolve: () => ({ cwd: "/owned", revision }),
      read: async (environmentId, input) => {
        seen.push({ environmentId, input });
        return pending.promise;
      },
    });
    const result = service.invoke(call({ relativePath: "README.md" }));
    revision = "v2";
    pending.resolve({
      relativePath: "README.md",
      contents: "old",
      byteLength: 3,
      truncated: false,
    });
    await expect(result).rejects.toThrow("Workspace changed");
    expect(seen).toEqual([
      { environmentId: "env-a", input: { cwd: "/owned", relativePath: "README.md" } },
    ]);
    const abort = new AbortController();
    abort.abort();
    await expect(
      service.invoke(call({ relativePath: "README.md" }, abort.signal)),
    ).rejects.toThrow();
    await expect(
      service.invoke({
        ...call({ relativePath: "README.md" }),
        context: { ...context, workspaceRevision: "old" },
      }),
    ).rejects.toThrow("revision");
  });
  it("preserves backend canonical containment errors", async () => {
    const service = createWorkspaceReadService({
      resolve: () => ({ cwd: "/owned", revision: "v1" }),
      read: async () => {
        throw new Error("resolved_path_outside_root");
      },
    });
    await expect(service.invoke(call({ relativePath: "linked-secret" }))).rejects.toThrow(
      "resolved_path_outside_root",
    );
  });
  it("separates matching path labels across environments and rejects in-flight revocation", async () => {
    const dependencies = {
      resolve: () => ({ cwd: "/same-label", revision: "v1" }),
      read: async (environmentId: string) => ({
        relativePath: "a",
        contents: environmentId,
        byteLength: 5,
        truncated: false,
      }),
    };
    const service = createWorkspaceReadService(dependencies);
    const [first, second] = await Promise.all([
      service.invoke(call({ relativePath: "a" })),
      service.invoke({
        ...call({ relativePath: "a" }),
        context: { ...context, resource: { ...context.resource, environmentId: "env-b" } },
      }),
    ]);
    expect(first).toMatchObject({ contents: "env-a" });
    expect(second).toMatchObject({ contents: "env-b" });
    let enabled = true;
    const pending = deferred<{
      relativePath: string;
      contents: string;
      byteLength: number;
      truncated: boolean;
    }>();
    const options = workspaceReadHostOptions(
      { ...dependencies, read: () => pending.promise },
      {
        extensionId: "example.reader",
        environmentId: "env-a",
        projectId: "project",
        isEnabled: () => enabled,
      },
    );
    const result = options.services![0]!.invoke(call({ relativePath: "a" }));
    enabled = false;
    pending.resolve({ relativePath: "a", contents: "secret", byteLength: 6, truncated: false });
    await expect(result).rejects.toThrow("revoked");
  });
  it("suppresses a read that completes after its signal is aborted", async () => {
    const pending = deferred<{
      relativePath: string;
      contents: string;
      byteLength: number;
      truncated: boolean;
    }>();
    const service = createWorkspaceReadService({
      resolve: () => ({ cwd: "/owned", revision: "v1" }),
      read: () => pending.promise,
    });
    const abort = new AbortController();
    const result = service.invoke(call({ relativePath: "a" }, abort.signal));
    abort.abort();
    pending.resolve({ relativePath: "a", contents: "late", byteLength: 4, truncated: false });
    await expect(result).rejects.toThrow();
  });
  it("bounds complete escaped Unicode JSON and keeps truncation truthful", () => {
    const contents = '"\\\n😀'.repeat(30_000);
    const result = boundedWorkspaceText(
      {
        relativePath: "a",
        contents,
        byteLength: new TextEncoder().encode(contents).length,
        truncated: false,
      },
      "a",
    );
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(
      MAX_PAYLOAD_BYTES,
    );
    expect(result.truncated).toBe(true);
    expect(contents.startsWith(result.contents)).toBe(true);
    expect(/[\uD800-\uDBFF]$/.test(result.contents)).toBe(false);
    expect(copyJson(result)).toEqual(result);
    expect(
      boundedWorkspaceText(
        { relativePath: "a", contents: "ok", byteLength: 2, truncated: false },
        "a",
      ).truncated,
    ).toBe(false);
    expect(() =>
      boundedWorkspaceText(
        { relativePath: "other", contents: "", byteLength: 0, truncated: false },
        "a",
      ),
    ).toThrow("Invalid");
  });
  it("caps an oversized backend result without admitting a multi-megabyte JSON payload", () => {
    const contents = "x".repeat(4 * 1024 * 1024);
    const result = boundedWorkspaceText(
      { relativePath: "large.txt", contents, byteLength: contents.length, truncated: false },
      "large.txt",
    );
    expect(result.contents.length).toBeLessThan(MAX_PAYLOAD_BYTES);
    expect(result.byteLength).toBe(contents.length);
    expect(result.truncated).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(
      MAX_PAYLOAD_BYTES,
    );
  });
  it("enforces extension/environment/project grants repeatedly through the public host", async () => {
    let enabled = true;
    const extension: Extension<{ read(): Promise<unknown> }> = {
      manifest: {
        id: "example.reader",
        apiVersion: 1,
        version: "1.0.0",
        surfaces: [
          {
            id: "example.reader/view",
            title: "Reader",
            scope: "project",
            clients: ["web"],
            placements: ["side-panel"],
            capabilities: [WORKSPACE_READ_TEXT],
            stateVersion: 1,
          },
        ],
      },
      surfaces: [
        {
          id: "example.reader/view",
          validateRestore: (state) => state === null,
          createView: (session) => ({
            renderer: { read: () => session.invoke(WORKSPACE_READ_TEXT, { relativePath: "a" }) },
          }),
        },
      ],
    };
    const options = workspaceReadHostOptions(
      {
        resolve: () => ({ cwd: "/owned", revision: "v1" }),
        read: async (environmentId) => ({
          relativePath: "a",
          contents: environmentId,
          byteLength: 5,
          truncated: false,
        }),
      },
      {
        extensionId: "example.reader",
        environmentId: "env-a",
        projectId: "project",
        isEnabled: () => enabled,
      },
    );
    expect(options.authorize("other.reader", WORKSPACE_READ_TEXT, context)).toBe(false);
    expect(
      options.authorize("example.reader", WORKSPACE_READ_TEXT, {
        ...context,
        resource: { ...context.resource, environmentId: "env-b" },
      }),
    ).toBe(false);
    expect(
      options.authorize("example.reader", WORKSPACE_READ_TEXT, {
        ...context,
        resource: { ...context.resource, projectId: "other" },
      }),
    ).toBe(false);
    const host = createExtensionHost<{ read(): Promise<unknown> }>(options);
    try {
      host.register(extension);
      const id = await host.restore({
        version: 1,
        surfaceId: "example.reader/view",
        placement: "side-panel",
        stateVersion: 1,
        restoreState: null,
        fallback: "Unavailable",
        context,
      });
      await expect(host.renderer(id)!.read()).resolves.toMatchObject({ contents: "env-a" });
      enabled = false;
      await expect(host.renderer(id)!.read()).rejects.toThrow();
    } finally {
      host.dispose();
    }
  });
});
