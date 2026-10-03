import { EnvironmentId, ProjectReadFileError, type EditorId } from "@t3tools/contracts";
import { RelayConnectionTarget } from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, useEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useEditorOpening, useOpenInPreferredEditor } from "./editorPreferences";
import { useLocalWslEditor } from "./localWslEditor";

const { serverLaunch, readFile, openExternal, browserAssign, environmentPresentation } = vi.hoisted(
  () => ({
    serverLaunch: vi.fn(),
    readFile: vi.fn(),
    openExternal: vi.fn(),
    browserAssign: vi.fn(),
    environmentPresentation: vi.fn(),
  }),
);

vi.mock("./state/use-atom-command", () => ({ useAtomCommand: () => serverLaunch }));
vi.mock("./state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => readFile }));
vi.mock("./state/presentation", () => ({
  useEnvironmentPresentation: environmentPresentation,
}));

const uliverse = EnvironmentId.make("uliverse");
const homebase = EnvironmentId.make("homebase");
const noEditors: readonly EditorId[] = [];

describe("device-local WSL editor opening", () => {
  let renderer: ReactTestRenderer | undefined;
  let current:
    | {
        opening: ReturnType<typeof useEditorOpening>;
        preference: ReturnType<typeof useLocalWslEditor>;
        openFile: ReturnType<typeof useOpenInPreferredEditor>;
      }
    | undefined;
  const getCurrent = () => {
    if (current === undefined) throw new Error("Editor opening harness has not rendered");
    return current;
  };
  function Harness({
    environmentId,
    editors = noEditors,
  }: {
    environmentId: EnvironmentId;
    editors?: readonly EditorId[];
  }) {
    const opening = useEditorOpening(environmentId, editors);
    const preference = useLocalWslEditor(environmentId);
    const openFile = useOpenInPreferredEditor(environmentId, editors);
    useEffect(() => {
      current = { opening, preference, openFile };
    }, [opening, preference, openFile]);
    return null;
  }
  beforeEach(() => {
    current = undefined;
    serverLaunch.mockReset().mockResolvedValue(AsyncResult.success(undefined));
    readFile.mockReset().mockResolvedValue(AsyncResult.success({ contents: "" }));
    openExternal.mockReset().mockResolvedValue(true);
    browserAssign.mockReset();
    environmentPresentation.mockReset().mockImplementation((environmentId: EnvironmentId) => ({
      presentation: {
        entry: {
          target: new RelayConnectionTarget({ environmentId, label: "Uliverse" }),
          profile: Option.none(),
        },
        serverConfig: { remoteOpenTargets: [] },
      },
    }));
    const storage = new Map<string, string>();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("navigator", { platform: "Win32" });
    vi.stubGlobal(
      "window",
      Object.assign(new EventTarget(), {
        localStorage: {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => storage.set(key, value),
          removeItem: (key: string) => storage.delete(key),
        },
        desktopBridge: {
          openExternal,
          probeRemoteEditors: async () => ["vscode"],
        },
        location: { assign: browserAssign },
      }),
    );
  });
  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    vi.unstubAllGlobals();
  });

  it("enables opening without sshd, persists across remounts, and restores Automatic", async () => {
    await act(async () => {
      renderer = create(<Harness environmentId={uliverse} />);
    });
    expect(getCurrent().opening.remote.mode).toBe("remote-unavailable");
    await act(async () => {
      getCurrent().preference[1]({ distro: "Ubuntu" });
    });
    expect(getCurrent().opening.preferredEditor).toBe("vscode");
    await act(async () => {
      expect((await getCurrent().opening.openEditor("/home/ulima/my repo"))._tag).toBe("Success");
    });
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(
      "vscode://vscode-remote/wsl+Ubuntu/home/ulima/my%20repo",
    );
    expect(serverLaunch).not.toHaveBeenCalled();

    await act(async () => renderer?.unmount());
    await act(async () => {
      renderer = create(<Harness environmentId={uliverse} />);
    });
    expect(getCurrent().preference[0]).toEqual({ distro: "Ubuntu" });
    await act(async () => {
      getCurrent().preference[1](null);
    });
    expect(getCurrent().opening.remote.mode).toBe("remote-unavailable");
    expect(getCurrent().opening.preferredEditor).toBeNull();
  });

  it("does not reuse one environment's distro after switching environments", async () => {
    await act(async () => {
      renderer = create(<Harness environmentId={uliverse} />);
    });
    await act(async () => {
      getCurrent().preference[1]({ distro: "Ubuntu" });
    });
    await act(async () => {
      renderer?.update(<Harness environmentId={homebase} />);
    });
    expect(getCurrent().preference[0]).toBeNull();
    expect(getCurrent().opening.remote.mode).toBe("remote-unavailable");
    await act(async () => {
      renderer?.update(<Harness environmentId={uliverse} />);
    });
    expect(getCurrent().opening.remote).toEqual({
      mode: "remote-links",
      host: { kind: "wsl", host: "Ubuntu" },
    });
  });

  it("reports a refused desktop link without recording a successful launch", async () => {
    openExternal.mockResolvedValue(false);
    await act(async () => {
      renderer = create(<Harness environmentId={uliverse} />);
    });
    await act(async () => {
      getCurrent().preference[1]({ distro: "Ubuntu" });
    });
    await act(async () => {
      expect((await getCurrent().opening.openEditor("/home/ulima/repo"))._tag).toBe("Failure");
    });
    expect(window.localStorage.getItem("t3code:last-editor")).toBeNull();
    expect(serverLaunch).not.toHaveBeenCalled();
  });

  it("opens files from a Windows browser through its URL handler", async () => {
    Object.defineProperty(window, "desktopBridge", { value: undefined });
    await act(async () => {
      renderer = create(<Harness environmentId={uliverse} />);
    });
    await act(async () => {
      getCurrent().preference[1]({ distro: "Ubuntu" });
    });
    await act(async () => {
      expect((await getCurrent().openFile("/home/ulima/repo/file.ts"))._tag).toBe("Success");
    });
    expect(browserAssign).toHaveBeenCalledExactlyOnceWith(
      "vscode://vscode-remote/wsl+Ubuntu/home/ulima/repo/file.ts%3A1",
    );
    expect(serverLaunch).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("opens known folders without a file position or a classification query", async () => {
    await act(async () => {
      renderer = create(<Harness environmentId={uliverse} />);
    });
    await act(async () => getCurrent().preference[1]({ distro: "Ubuntu" }));
    await act(async () => {
      expect(
        (await getCurrent().opening.openEditor("/home/ulima/repo", undefined, "directory"))._tag,
      ).toBe("Success");
    });
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(
      "vscode://vscode-remote/wsl+Ubuntu/home/ulima/repo",
    );
    expect(readFile).not.toHaveBeenCalled();
  });

  it.each([
    { failure: "path_not_file" as const, suffix: "" },
    { failure: "binary_file" as const, suffix: "%3A1" },
    { failure: undefined, suffix: "%3A1" },
  ])(
    "opens an unpositioned terminal path with its actual target kind ($failure)",
    async ({ failure, suffix }) => {
      if (failure) {
        readFile.mockResolvedValue(
          AsyncResult.failure(
            Cause.fail(
              new ProjectReadFileError({
                cwd: "/",
                relativePath: "/home/ulima/repo/target",
                failure,
              }),
            ),
          ),
        );
      }
      await act(async () => {
        renderer = create(<Harness environmentId={uliverse} />);
      });
      await act(async () => getCurrent().preference[1]({ distro: "Ubuntu" }));
      await act(async () => {
        expect((await getCurrent().openFile("/home/ulima/repo/target", "auto"))._tag).toBe(
          "Success",
        );
      });
      expect(readFile).toHaveBeenCalledExactlyOnceWith({
        environmentId: uliverse,
        input: { cwd: "/", relativePath: "/home/ulima/repo/target" },
      });
      expect(openExternal).toHaveBeenCalledExactlyOnceWith(
        `vscode://vscode-remote/wsl+Ubuntu/home/ulima/repo/target${suffix}`,
      );
    },
  );

  it("preserves a terminal file position without querying the file", async () => {
    await act(async () => {
      renderer = create(<Harness environmentId={uliverse} />);
    });
    await act(async () => getCurrent().preference[1]({ distro: "Ubuntu" }));
    await act(async () => {
      expect((await getCurrent().openFile("/home/ulima/repo/file.ts:12:3", "auto"))._tag).toBe(
        "Success",
      );
    });
    expect(readFile).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(
      "vscode://vscode-remote/wsl+Ubuntu/home/ulima/repo/file.ts%3A12%3A3",
    );
  });

  it("reports classification failures without launching or recording an editor", async () => {
    readFile.mockResolvedValue(
      AsyncResult.failure(
        Cause.fail(
          new ProjectReadFileError({
            cwd: "/",
            relativePath: "/home/ulima/repo/missing",
            failure: "operation_failed",
          }),
        ),
      ),
    );
    await act(async () => {
      renderer = create(<Harness environmentId={uliverse} />);
    });
    await act(async () => getCurrent().preference[1]({ distro: "Ubuntu" }));
    await act(async () => {
      expect((await getCurrent().openFile("/home/ulima/repo/missing", "auto"))._tag).toBe(
        "Failure",
      );
    });
    expect(openExternal).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("t3code:last-editor")).toBeNull();
  });

  it("keeps the mapping out of another browser profile", async () => {
    await act(async () => {
      renderer = create(<Harness environmentId={uliverse} />);
    });
    await act(async () => {
      getCurrent().preference[1]({ distro: "Ubuntu" });
    });
    await act(async () => renderer?.unmount());
    Object.defineProperty(window, "localStorage", {
      value: { getItem: () => null },
    });
    await act(async () => {
      renderer = create(<Harness environmentId={uliverse} />);
    });
    expect(getCurrent().opening.remote.mode).toBe("remote-unavailable");
  });

  it("preserves Automatic execution for an environment on the same machine", async () => {
    environmentPresentation.mockReturnValue({
      presentation: { entry: { target: null, profile: Option.none() }, serverConfig: {} },
    });
    await act(async () => {
      renderer = create(<Harness environmentId={uliverse} editors={["cursor"]} />);
    });
    await act(async () => {
      expect((await getCurrent().openFile("/home/ulima/repo", "auto"))._tag).toBe("Success");
    });
    expect(serverLaunch).toHaveBeenCalledExactlyOnceWith({
      environmentId: uliverse,
      input: { cwd: "/home/ulima/repo", editor: "cursor" },
    });
    expect(openExternal).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("preserves Automatic SSH links for another environment", async () => {
    environmentPresentation.mockReturnValue({
      presentation: {
        entry: {
          target: new RelayConnectionTarget({ environmentId: homebase, label: "Homebase" }),
          profile: Option.none(),
        },
        serverConfig: { remoteOpenTargets: [{ kind: "tailscale", host: "homebase" }] },
      },
    });
    await act(async () => {
      renderer = create(<Harness environmentId={homebase} />);
    });
    await act(async () => {
      expect((await getCurrent().openFile("/home/ulima/repo", "auto"))._tag).toBe("Success");
    });
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(
      "vscode://vscode-remote/ssh-remote+homebase/home/ulima/repo",
    );
    expect(serverLaunch).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });
});
