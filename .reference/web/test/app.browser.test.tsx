import * as React from "react"
import { RegistryProvider } from "@effect/atom-react"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import * as Atom from "effect/unstable/reactivity/Atom"
import { describe, expect, it, vi } from "vitest"
import { render } from "vitest-browser-react"
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router"
import { getRouter } from "../src/router"

vi.mock("../src/rpc.ts", () => {
  const initialSnapshot = AsyncResult.success({
    offset: 42,
    todos: [
      {
        id: "todo-1",
        title: "Harness Todo",
        completed: false,
        archived: false,
        revision: 1,
        updatedAt: "2026-03-05T00:00:00.000Z"
      }
    ]
  })

  const noopSubscription = AsyncResult.initial<{
    readonly done: boolean
    readonly items: ReadonlyArray<unknown>
  }>(true)

  const mutationResult = AsyncResult.success({
    offset: 43,
    at: "2026-03-05T00:00:01.000Z",
    todo: {
      id: "todo-1",
      title: "Harness Todo",
      completed: false,
      archived: false,
      revision: 1,
      updatedAt: "2026-03-05T00:00:01.000Z"
    },
    change: { _tag: "TodoRenamed", title: "Harness Todo" as const }
  })

  return {
    todosSnapshotAtom: Atom.make(initialSnapshot),
    subscribeTodosPullAtom: Atom.writable(
      () => noopSubscription,
      () => {
        // no-op: smoke test doesn't exercise stream pulling
      }
    ),
    renameTodoMutationAtom: Atom.make(mutationResult),
    completeTodoMutationAtom: Atom.make(mutationResult),
    archiveTodoMutationAtom: Atom.make(mutationResult)
  }
})



describe("web app harness", () => {
  it("renders App in browser mode", async () => {
    const history = createMemoryHistory()
    const router = getRouter(history)
    const screen = await render(
      <RegistryProvider>
        <RouterProvider router={router} />
      </RegistryProvider>
    )

    await expect.element(screen.getByRole("heading", { name: "Realtime Todo Stream" })).toBeVisible()
    await expect.element(screen.getByRole("heading", { name: "Todos" })).toBeVisible()
    await expect.element(screen.getByRole("textbox")).toHaveValue("Harness Todo")
  })
})
