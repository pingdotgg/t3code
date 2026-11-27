import { RegistryContext } from "@effect/atom-react";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

type ButtonProps = { label: string; loading?: boolean; onPress: () => void };
const mocks = vi.hoisted(() => {
  let markLoaded!: () => void;
  const loaded = new Promise<void>((resolve) => (markLoaded = resolve));
  let ids = 0;
  return {
    write: vi.fn<(file: unknown, contents: string) => Promise<void>>(),
    goBack: vi.fn(),
    button: null as ButtonProps | null,
    saving: Promise.resolve() as Promise<unknown>,
    changeText: (_text: string) => {},
    uuid: () => `comment-${++ids}`,
    loaded,
    markLoaded,
  };
});
vi.mock("expo-file-system", () => ({
  Directory: class {
    create() {}
  },
  File: class {
    // The draft store reads this once while loading and sets ready in the same tick.
    get exists() {
      mocks.markLoaded();
      return false;
    }
  },
  Paths: { document: {} },
}));
vi.mock("../../lib/atomic-file", () => ({ writeFileAtomically: mocks.write }));
vi.mock("../../lib/uuid", () => ({ uuidv4: mocks.uuid }));
vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => {
  const runtime = await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>();
  return {
    ...runtime,
    // Save gives the press handler no promise, so the test awaits the one save awaits.
    settlePromise: <A,>(execute: () => Promise<A>) =>
      (mocks.saving = runtime.settlePromise(execute)),
  };
});
vi.mock("react-native", () => ({
  AppState: { addEventListener: () => ({ remove() {} }) },
  View: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: mocks.goBack }),
  useFocusEffect: () => {},
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: () => {} }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  AppTextInput: (props: { onChangeText: (text: string) => void }) => {
    mocks.changeText = props.onChangeText;
    return null;
  },
}));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: ButtonProps) => {
    mocks.button = props;
    return null;
  },
}));
vi.mock("./PullRequestSheetContent", () => ({
  PullRequestSheetContent: (props: { children: ReactNode; footer: ReactNode }) => (
    <>
      {props.children}
      {props.footer}
    </>
  ),
}));
vi.mock("../../state/pull-requests", () => ({ composerPullRequests: { detail: () => null } }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { headSha: "head", capabilities: null },
    isPending: false,
    error: null,
    refresh: () => {},
  }),
}));
vi.mock("./usePullRequestDiff", () => ({ pullRequestTarget: () => null }));
vi.mock("./usePullRequestPermissions", () => ({
  usePullRequestPermissions: () => ({ canInlineComment: true }),
}));
vi.mock("./PullRequestCompletionSuggestions", () => ({
  PullRequestCompletionSuggestions: () => null,
}));
vi.mock("./usePullRequestCompletions", () => ({ usePullRequestCompletions: () => ({}) }));

import { appAtomRegistry } from "../../state/atom-registry";
import { PullRequestInlineCommentScreen } from "./PullRequestInlineCommentScreen";

it("keeps a new comment open after a failed save and saves it once on retry", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  const params = {
    environmentId: "environment",
    projectId: "project",
    repository: "owner/repo",
    number: 1,
    path: "src/a.ts",
    position: { kind: "added" as const, newLine: 3 },
    headSha: "head",
    code: "const a = 1;",
  };
  act(() =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <PullRequestInlineCommentScreen route={{ params } as never} />
      </RegistryContext.Provider>,
    ),
  );
  await act(() => mocks.loaded);
  act(() => mocks.changeText("Rename this"));
  const failure = Promise.withResolvers<void>();
  mocks.write.mockImplementationOnce(async () => {
    await failure.promise;
    throw new Error("ENOSPC");
  });
  act(() => mocks.button?.onPress());
  expect(mocks.button).toMatchObject({ label: "Saving…", loading: true });
  await act(async () => {
    failure.resolve();
    await mocks.saving;
  });
  expect(mocks.button).toMatchObject({ label: "Save draft", loading: false });
  expect(container.textContent).toContain("could not be saved on this device");
  expect(mocks.goBack).not.toHaveBeenCalled();

  mocks.write.mockResolvedValueOnce(undefined);
  act(() => mocks.button?.onPress());
  await act(() => mocks.saving);
  expect(mocks.goBack).toHaveBeenCalledTimes(1);
  const written = JSON.parse(mocks.write.mock.lastCall?.[1] ?? "{}");
  expect(
    Object.values(written.drafts).flatMap((draft) => (draft as { comments: unknown[] }).comments),
  ).toEqual([expect.objectContaining({ id: "comment-1", body: "Rename this" })]);
});
