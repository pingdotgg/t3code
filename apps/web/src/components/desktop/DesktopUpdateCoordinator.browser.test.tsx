import type {
  DesktopUpdateCommandRequest,
  DesktopUpdateCommandResponse,
  DesktopUpdateState,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { act, render, stubGlobal } from "../../../test/render";
import "../../index.css";
import { DesktopUpdateCoordinator } from "./DesktopUpdateCoordinator";
import { ToastProvider } from "../ui/toast";

const mocks = vi.hoisted(() => ({ run: vi.fn(async () => undefined) }));
vi.mock("../sidebar/useUpdateEverything", () => ({
  useUpdateEverything: () => ({
    hasUpdates: true,
    version: "0.1.8",
    providerCount: 0,
    rows: [
      { environmentId: null, label: "This app", app: "this-app", skipped: null, providers: [] },
    ],
    restarts: [],
    run: mocks.run,
  }),
}));

const state: DesktopUpdateState = {
  enabled: true,
  status: "available",
  channel: "latest",
  currentVersion: "0.1.7",
  availableVersion: "0.1.8",
  downloadedVersion: null,
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

it("uses one native confirmation and cancels without starting the coordinated runner", async () => {
  mocks.run.mockClear();
  let listener: ((request: DesktopUpdateCommandRequest) => void) | undefined;
  const complete = vi.fn(async () => true);
  const finish = vi.fn(async () => undefined);
  using _bridge = stubGlobal("desktopBridge", {
    getUpdateState: async () => state,
    updateCommand: {
      setReady: async () => undefined,
      complete,
      finish,
      onRequest: (callback: typeof listener) => {
        listener = callback;
        return () => {
          listener = undefined;
        };
      },
    },
  });
  await using screen = await render(<DesktopUpdateCoordinator />);
  await act(async () => listener?.({ version: 1, requestId: "cli", type: "update" }));
  await expect.element(page.getByRole("alertdialog", { name: "Update 1 machine?" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Cancel", exact: true }));
  await vi.waitFor(() =>
    expect(complete).toHaveBeenCalledWith({
      version: 1,
      requestId: "cli",
      ok: true,
      status: "cancelled",
    }),
  );
  expect(mocks.run).not.toHaveBeenCalled();
  await act(async () => listener?.({ version: 1, requestId: "about", type: "update" }));
  await expect.element(page.getByRole("alertdialog", { name: "Update 1 machine?" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Update", exact: true }));
  await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledOnce());
  expect(complete).toHaveBeenCalledWith({
    version: 1,
    requestId: "about",
    ok: true,
    status: "started",
  });
  await vi.waitFor(() => expect(finish).toHaveBeenCalledOnce());
});

it("replaces a disconnected confirmation and ignores its late preparation", async () => {
  mocks.run.mockClear();
  let listener: ((request: DesktopUpdateCommandRequest) => void) | undefined;
  let releaseOld: ((value: DesktopUpdateState) => void) | undefined;
  const oldState = new Promise<DesktopUpdateState>((resolve) => {
    releaseOld = resolve;
  });
  const getUpdateState = vi
    .fn()
    .mockImplementationOnce(() => oldState)
    .mockResolvedValue(state);
  const complete = vi.fn(
    async (response: DesktopUpdateCommandResponse) => response.requestId === "new",
  );
  const finish = vi.fn(async () => undefined);
  using _bridge = stubGlobal("desktopBridge", {
    getUpdateState,
    updateCommand: {
      setReady: async () => undefined,
      complete,
      finish,
      onRequest: (callback: typeof listener) => {
        listener = callback;
        return () => {
          listener = undefined;
        };
      },
    },
  });
  await using screen = await render(<DesktopUpdateCoordinator />);
  await act(async () => listener?.({ version: 1, requestId: "old", type: "update" }));
  // The old caller disconnected while preparing; the native owner admitted its successor.
  await act(async () => listener?.({ version: 1, requestId: "new", type: "update" }));
  await expect.element(page.getByRole("alertdialog", { name: "Update 1 machine?" })).toBeVisible();
  await act(async () => releaseOld?.({ ...state, availableVersion: "obsolete" }));
  await userEvent.click(screen.getByRole("button", { name: "Update", exact: true }));
  await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledOnce());
  expect(complete).toHaveBeenCalledWith({
    version: 1,
    requestId: "new",
    ok: true,
    status: "started",
  });
  expect(complete).not.toHaveBeenCalledWith(
    expect.objectContaining({ requestId: "old", status: "started" }),
  );
  await vi.waitFor(() => expect(finish).toHaveBeenCalledWith("new"));
  expect(finish).not.toHaveBeenCalledWith("old");
});

it("explains an expired confirmation without starting an update", async () => {
  mocks.run.mockClear();
  let listener: ((request: DesktopUpdateCommandRequest) => void) | undefined;
  using _bridge = stubGlobal("desktopBridge", {
    getUpdateState: async () => state,
    updateCommand: {
      setReady: async () => undefined,
      complete: async () => false,
      finish: async () => undefined,
      onRequest: (callback: typeof listener) => {
        listener = callback;
        return () => {
          listener = undefined;
        };
      },
    },
  });
  await using screen = await render(
    <ToastProvider>
      <DesktopUpdateCoordinator />
    </ToastProvider>,
  );
  await act(async () => listener?.({ version: 1, requestId: "expired", type: "update" }));
  await expect.element(page.getByRole("alertdialog", { name: "Update 1 machine?" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Update", exact: true }));
  await expect
    .element(page.getByText("This update request expired or was replaced. Start the update again."))
    .toBeVisible();
  expect(mocks.run).not.toHaveBeenCalled();
});
