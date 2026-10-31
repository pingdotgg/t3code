import { EnvironmentId, TaskDocumentId, type OpenTaskDocument } from "@t3tools/contracts";
import { useAtomSet } from "@effect/atom-react";
import { type Atom, AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({
  supported: true,
  generationAtom: null as never as Atom.Writable<number>,
  list: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
  documents: new Map<string, OpenTaskDocument>(),
}));

vi.mock(import("~/connection/catalog"), async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentCatalog: {
      sessionGenerationAtom: () => (state.generationAtom ??= Atom.make(1)),
    } as never,
  };
});

vi.mock(import("~/state/entities"), () => ({
  useServerConfigs: (() => ({
    get: () => ({ environment: { capabilities: { taskDocuments: state.supported } } }),
  })) as never,
}));
vi.mock(import("~/state/taskDocuments"), async () => {
  const { Atom } = await import("effect/reactivity");
  const permitted = Atom.make(true);
  return {
    taskDocumentEnvironment: {
      ...Object.fromEntries(
        ["register", "open", "list", "save"].map((name) => [
          name,
          { name, permissionAtom: () => permitted },
        ]),
      ),
      catalogueChanges: ({ environmentId }: { environmentId: string }) => ({ environmentId }),
      documentChanges: ({ input }: { input: { taskDocumentId: string } }) => input,
    } as never,
  };
});
vi.mock(import("~/state/use-atom-command"), () => ({
  useAtomCommand: ((command: { name: "list" | "open" | "save" }) => state[command.name]) as never,
}));
vi.mock(import("~/state/query"), () => ({
  useEnvironmentQuery: ((query: { taskDocumentId?: string } | null) => ({
    data:
      query === null ? null : query.taskDocumentId ? state.documents.get(query.taskDocumentId) : 1,
    error: null,
  })) as never,
}));

import { useTaskCatalogue, useTaskDocument } from "./useTaskDocuments";
import { environmentCatalog } from "~/connection/catalog";

environmentCatalog.sessionGenerationAtom(EnvironmentId.make("initial"));
const taskDocumentId = TaskDocumentId.make("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");

function document(contents: string, revision: string): OpenTaskDocument {
  return {
    contents,
    revision: revision.repeat(64),
    summary: {
      taskDocumentId,
      canonicalPath: "/tasks/task.md",
      locatorVersion: 0,
      observedFileId: null,
      registered: true,
      title: contents,
      state: null,
      pinned: false,
      availability: "available",
      revision: revision.repeat(64),
    },
  };
}

function setup() {
  state.supported = true;
  state.list.mockReset();
  state.open.mockReset();
  state.save.mockReset();
  state.documents.clear();
}

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function Catalogue({ environmentId }: { environmentId: EnvironmentId }) {
  const { tasks } = useTaskCatalogue(environmentId);
  const setGeneration = useAtomSet(state.generationAtom);
  return (
    <>
      <output aria-label="Tasks">{tasks.map((task) => task.title).join(", ")}</output>
      <button onClick={() => setGeneration((generation) => generation + 1)}>Reconnect</button>
    </>
  );
}

function Document() {
  const { state, session, save, canRead, canSave } = useTaskDocument(
    EnvironmentId.make("save-race"),
    taskDocumentId,
  );
  return (
    <>
      <output aria-label="Draft">{state.draft}</output>
      <output aria-label="Access">{`${canRead}:${canSave}`}</output>
      <button onClick={() => session.edit("saved draft")}>Edit</button>
      <button onClick={() => void save()}>Save</button>
    </>
  );
}

it("isolates catalogues across environments and refreshes after reconnect without a notice", async () => {
  setup();
  state.list.mockResolvedValueOnce(AsyncResult.success([document("Environment A", "a").summary]));
  const pending = deferred<AsyncResult.AsyncResult<ReadonlyArray<never>>>();
  state.list.mockReturnValueOnce(pending.promise);
  await using screen = await render(
    <Catalogue environmentId={EnvironmentId.make("catalogue-a")} />,
  );
  await expect.element(screen.getByLabelText("Tasks")).toHaveTextContent("Environment A");
  await screen.rerender(<Catalogue environmentId={EnvironmentId.make("catalogue-b")} />);
  await expect.element(screen.getByLabelText("Tasks")).toHaveTextContent("");
  await act(() => pending.resolve(AsyncResult.success([])));
  state.list.mockResolvedValueOnce(
    AsyncResult.success([document("Imported while offline", "b").summary]),
  );
  await userEvent.click(screen.getByRole("button", { name: "Reconnect" }));
  await expect.element(screen.getByLabelText("Tasks")).toHaveTextContent("Imported while offline");
});

it("refreshes a change received during save and stops document access on an unsupported server", async () => {
  setup();
  state.documents.set(taskDocumentId, document("base", "a"));
  const pending = deferred<AsyncResult.AsyncResult<OpenTaskDocument>>();
  state.save.mockReturnValueOnce(pending.promise);
  const external = document("external change", "c");
  state.open.mockResolvedValue(AsyncResult.success(external));
  await using screen = await render(<Document />);
  await expect.element(screen.getByLabelText("Draft")).toHaveTextContent("base");
  await userEvent.click(screen.getByRole("button", { name: "Edit" }));
  await userEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
  state.documents.set(taskDocumentId, external);
  await screen.rerender(<Document />);
  await act(() => pending.resolve(AsyncResult.success(document("saved draft", "b"))));
  await expect.element(screen.getByLabelText("Draft")).toHaveTextContent("external change");
  state.supported = false;
  await screen.rerender(<Document />);
  await expect.element(screen.getByLabelText("Access")).toHaveTextContent("false:false");
});
