import * as Atom from "effect/unstable/reactivity/Atom"
import type { Todo, TodoEvent } from "@effect-http-ws-cli/server/contracts"

export type SubscriptionState = "connecting" | "connected" | "idle"

export interface TodoProjectionState {
  readonly todos: ReadonlyArray<Todo>
  readonly titleDrafts: Readonly<Record<string, string>>
  readonly lastOffset: number
}

export interface ConnectionState {
  readonly subscriptionState: SubscriptionState
  readonly lastError: string | null
}

export const todoProjectionAtom = Atom.make<TodoProjectionState>({
  todos: [],
  titleDrafts: {},
  lastOffset: 0
}).pipe(Atom.withLabel("todo-projection"))

export const eventsAtom = Atom.make<ReadonlyArray<TodoEvent>>([]).pipe(
  Atom.withLabel("events")
)

export const connectionAtom = Atom.make<ConnectionState>({
  subscriptionState: "idle",
  lastError: null
}).pipe(Atom.withLabel("connection"))

export const mutationBusyAtom = Atom.make<string | null>(null).pipe(
  Atom.withLabel("mutation-busy")
)
