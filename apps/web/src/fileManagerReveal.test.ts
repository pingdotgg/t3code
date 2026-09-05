import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it, vi } from "vite-plus/test";

import { fileManagerActionForPresentation, resolveLiteralFilePath } from "./fileManagerReveal";

const localEnvironmentId = EnvironmentId.make("local-environment");
const remoteEnvironmentId = EnvironmentId.make("remote-environment");

describe("resolveLiteralFilePath", () => {
  it.each([
    ["POSIX absolute", "/workspace/file.txt", "/project", "/workspace/file.txt"],
    [
      "Windows drive absolute",
      String.raw`C:\workspace\file.txt`,
      "/project",
      String.raw`C:\workspace\file.txt`,
    ],
    [
      "Windows drive absolute with POSIX separators",
      "C:/workspace/file.txt",
      "/project",
      "C:/workspace/file.txt",
    ],
    [
      "UNC absolute",
      String.raw`\\server\share\file.txt`,
      "/project",
      String.raw`\\server\share\file.txt`,
    ],
    ["POSIX relative path", "src/file.txt", "/project", "/project/src/file.txt"],
    ["literal tilde on POSIX", "~/config.json", "/project", "/project/~/config.json"],
    ["literal colon on POSIX", "notes:1", "/project", "/project/notes:1"],
    [
      "literal backslash on POSIX",
      String.raw`notes\config.json`,
      "/project",
      String.raw`/project/notes\config.json`,
    ],
    [
      "Windows root with POSIX separators",
      "src/file.txt",
      "C:/project",
      String.raw`C:\project\src\file.txt`,
    ],
    [
      "Windows drive-root relative with backslash",
      String.raw`\report.pdf`,
      "C:/project",
      String.raw`C:\report.pdf`,
    ],
    [
      "Windows drive-root relative with POSIX separator",
      "/report.pdf",
      "C:/project",
      String.raw`C:\report.pdf`,
    ],
    [
      "UNC root with POSIX separators",
      "src/file.txt",
      String.raw`\\server\share\project`,
      String.raw`\\server\share\project\src\file.txt`,
    ],
    [
      "UNC volume-root relative with backslash",
      String.raw`\report.pdf`,
      String.raw`\\server\share\project`,
      String.raw`\\server\share\report.pdf`,
    ],
    [
      "UNC volume-root relative with POSIX separator",
      "/report.pdf",
      String.raw`\\server\share\project`,
      String.raw`\\server\share\report.pdf`,
    ],
  ] as const)("resolves %s", (_case, path, workspaceRoot, expected) => {
    expect(resolveLiteralFilePath(path, workspaceRoot)).toBe(expected);
  });
});

function presentation(
  environmentId: EnvironmentId,
  input: {
    readonly target?: "local" | "remote";
    readonly os?: "darwin" | "linux" | "windows" | "unknown";
    readonly kind?: "finder" | "file-explorer" | "files";
    readonly enabled?: boolean;
    readonly availableEditors?: ReadonlyArray<"file-manager">;
  } = {},
): Parameters<typeof fileManagerActionForPresentation>[1] {
  const target =
    input.target === "remote"
      ? new PrimaryConnectionTarget({
          environmentId,
          label: "remote",
          httpBaseUrl: "https://remote.example",
          wsBaseUrl: "wss://remote.example",
        })
      : new PrimaryConnectionTarget({
          environmentId,
          label: "local",
          httpBaseUrl: "http://127.0.0.1",
          wsBaseUrl: "ws://127.0.0.1",
        });
  return {
    entry: { target, profile: Option.none() },
    serverConfig: {
      availableEditors: input.availableEditors ?? ["file-manager"],
      environment: { platform: { os: input.os ?? "darwin" } },
      shellRevealInFileManager: input.enabled ?? true,
      ...(input.kind === undefined ? {} : { shellRevealInFileManagerKind: input.kind }),
      ...(input.target === "remote"
        ? { remoteOpenTargets: [{ kind: "tailscale", host: "remote.example" }] }
        : {}),
    },
  };
}

describe("fileManagerActionForPresentation", () => {
  it("keeps open available when reveal capability is unavailable", () => {
    const command = vi.fn<Parameters<typeof fileManagerActionForPresentation>[2]>();
    const action = fileManagerActionForPresentation(
      localEnvironmentId,
      presentation(localEnvironmentId, { os: "linux", enabled: false }),
      command,
    );

    expect(action).not.toBeNull();
    expect(action?.open.managerName).toBe("File Manager");
    expect(action?.reveal).toBeNull();
  });

  it("labels a local Linux files action as opening the containing folder", () => {
    const command = vi.fn<Parameters<typeof fileManagerActionForPresentation>[2]>();
    const action = fileManagerActionForPresentation(
      localEnvironmentId,
      presentation(localEnvironmentId, { os: "linux", kind: "files", enabled: true }),
      command,
    );

    expect(action?.reveal).toMatchObject({ label: "Open Containing Folder" });
  });

  it.each([
    [
      "the environment is remote",
      remoteEnvironmentId,
      presentation(remoteEnvironmentId, { target: "remote" }),
    ],
    [
      "the file-manager editor is unavailable",
      localEnvironmentId,
      presentation(localEnvironmentId, { availableEditors: [] }),
    ],
  ] as const)("returns null when %s", (_reason, environmentId, environmentPresentation) => {
    const command = vi.fn<Parameters<typeof fileManagerActionForPresentation>[2]>();

    expect(
      fileManagerActionForPresentation(environmentId, environmentPresentation, command),
    ).toBeNull();
  });
});
