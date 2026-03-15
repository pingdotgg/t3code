import { createFileRoute } from "@tanstack/react-router"



import { useEffect, useRef } from "react"
import * as Cause from "effect/Cause"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import type { Todo, TodoEvent, TodoChange } from "@effect-http-ws-cli/server/contracts"
import {
  archiveTodoMutationAtom,
  completeTodoMutationAtom,
  renameTodoMutationAtom,
  subscribeTodosPullAtom,
  todosSnapshotAtom
} from "../rpc"
import {
  connectionAtom,
  eventsAtom,
  mutationBusyAtom,
  todoProjectionAtom
} from "../state"

const reconnectBaseMs = 1_250
const reconnectMaxMs = 20_000
const maxReconnectAttempts = 8



export const Route = createFileRoute("/")({
  component: IndexRoute
})

function IndexRoute() {
  const setProjection = useAtomSet(todoProjectionAtom)
  const setEvents = useAtomSet(eventsAtom)
  const setConnection = useAtomSet(connectionAtom)
  const setBusy = useAtomSet(mutationBusyAtom)

  const snapshotResult = useAtomValue(todosSnapshotAtom)
  const subscriptionPullResult = useAtomValue(subscribeTodosPullAtom)
  const pullSubscription = useAtomSet(subscribeTodosPullAtom)
  const refreshSubscription = useAtomRefresh(subscribeTodosPullAtom)

  const seenOffsetsRef = useRef<Set<number>>(new Set())
  const baselineOffsetRef = useRef(0)
  const hasInitializedRef = useRef(false)
  const hasStartedSubscriptionRef = useRef(false)
  const brokenSubscriptionRef = useRef(false)

  const reconnectAttemptsRef = useRef(0)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearReconnectTimer = () => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
  }

  const startSubscriptionPull = () => {
    clearReconnectTimer()
    if (!hasStartedSubscriptionRef.current) {
      hasStartedSubscriptionRef.current = true
    }
    setConnection((current) => ({ ...current, subscriptionState: "connecting" }))
    refreshSubscription()
    pullSubscription(undefined)
  }

  const scheduleReconnect = (lastError: string) => {
    brokenSubscriptionRef.current = true
    reconnectAttemptsRef.current += 1

    if (reconnectAttemptsRef.current > maxReconnectAttempts) {
      setConnection((current) => ({
        ...current,
        lastError,
        subscriptionState: "idle"
      }))
      return
    }

    const delayMs = Math.min(
      reconnectBaseMs * 2 ** Math.max(0, reconnectAttemptsRef.current - 1),
      reconnectMaxMs
    )

    setConnection((current) => ({
      ...current,
      lastError,
      subscriptionState: "connecting"
    }))

    clearReconnectTimer()
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null
      startSubscriptionPull()
    }, delayMs)
  }

  const addEvent = (event: TodoEvent): boolean => {
    if (event.offset <= baselineOffsetRef.current) {
      return false
    }

    if (seenOffsetsRef.current.has(event.offset)) {
      return false
    }

    seenOffsetsRef.current.add(event.offset)
    setEvents((events) => [...events, event])
    return true
  }

  const applyEvent = (event: TodoEvent) => {
    setProjection((current) => ({
      ...current,
      lastOffset: Math.max(current.lastOffset, event.offset),
      todos: sortTodos(
        current.todos.some((todo) => todo.id === event.todo.id)
          ? current.todos.map((todo) => (todo.id === event.todo.id ? event.todo : todo))
          : [...current.todos, event.todo]
      ),
      titleDrafts: {
        ...current.titleDrafts,
        [event.todo.id]: event.todo.title
      }
    }))
  }

  const applyTodoEvent = (event: TodoEvent) => {
    const isNew = addEvent(event)
    if (isNew) {
      applyEvent(event)
    }
  }

  useEffect(() => {
    if (AsyncResult.isInitial(snapshotResult)) {
      return
    }

    if (AsyncResult.isFailure(snapshotResult)) {
      scheduleReconnect(Cause.pretty(snapshotResult.cause))
      return
    }

    const snapshot = snapshotResult.value

    setProjection({
      todos: sortTodos(snapshot.todos),
      lastOffset: snapshot.offset,
      titleDrafts: Object.fromEntries(snapshot.todos.map((todo) => [todo.id, todo.title]))
    })

    if (!hasInitializedRef.current) {
      hasInitializedRef.current = true
      baselineOffsetRef.current = snapshot.offset
      seenOffsetsRef.current = new Set()
      setEvents([])
      startSubscriptionPull()
    }
  }, [snapshotResult, setEvents, setProjection])

  useEffect(() => {
    if (!hasStartedSubscriptionRef.current) {
      return
    }

    if (AsyncResult.isInitial(subscriptionPullResult)) {
      setConnection((current) => ({
        ...current,
        subscriptionState: subscriptionPullResult.waiting ? "connected" : "connecting"
      }))
      return
    }

    if (AsyncResult.isFailure(subscriptionPullResult)) {
      scheduleReconnect(Cause.pretty(subscriptionPullResult.cause))
      return
    }

    reconnectAttemptsRef.current = 0
    brokenSubscriptionRef.current = false

    setConnection((current) => ({
      ...current,
      lastError: null,
      subscriptionState: "connected"
    }))

    for (const event of subscriptionPullResult.value.items) {
      applyTodoEvent(event)
    }

    if (!subscriptionPullResult.value.done && !subscriptionPullResult.waiting) {
      pullSubscription(undefined)
    }
  }, [pullSubscription, setConnection, subscriptionPullResult])

  useEffect(() => {
    const reconnectOnFocus = () => {
      if (document.visibilityState !== "visible") {
        return
      }

      if (!brokenSubscriptionRef.current) {
        return
      }

      reconnectAttemptsRef.current = 0
      startSubscriptionPull()
    }

    window.addEventListener("focus", reconnectOnFocus)
    document.addEventListener("visibilitychange", reconnectOnFocus)

    return () => {
      window.removeEventListener("focus", reconnectOnFocus)
      document.removeEventListener("visibilitychange", reconnectOnFocus)
    }
  }, [setConnection])

  useEffect(() => {
    return () => {
      clearReconnectTimer()
    }
  }, [])

  const runMutation: MutationRunner = (label, run, onSuccess) => {
    setBusy(label)
    setConnection((current) => ({ ...current, lastError: null }))

    void run().then(
      (value) => {
        onSuccess(value)
      },
      (error) => {
        setConnection((current) => ({ ...current, lastError: Cause.pretty(error) }))
      }
    ).finally(() => {
      setBusy(null)
    })
  }

  return (
    <main className="shell">
      <Status />

      <section className="hero">
        <p className="eyebrow">effect-http-ws-cli</p>
        <h1>Realtime Todo Stream</h1>
        <p className="lead">
          Snapshot on load, then live updates over typed WebSocket RPC subscriptions.
        </p>
      </section>

      <TodoPanel runMutation={runMutation} applyTodoEvent={applyTodoEvent} />
      <EventList />
      <Footer />
    </main>
  )
}




type MutationRunner = <A>(
  label: string,
  run: () => Promise<A>,
  onSuccess: (value: A) => void
) => void

const sortTodos = (todos: ReadonlyArray<Todo>): ReadonlyArray<Todo> =>
  [...todos].sort((a, b) => {
    if (a.archived !== b.archived) return a.archived ? 1 : -1
    if (a.completed !== b.completed) return a.completed ? 1 : -1
    return a.id.localeCompare(b.id)
  })

const describeChange = (change: TodoChange): string => {
  switch (change._tag) {
    case "TodoCreated":
      return "created"
    case "TodoRenamed":
      return `renamed to "${change.title}"`
    case "TodoCompleted":
      return change.completed ? "completed" : "marked incomplete"
    case "TodoArchived":
      return change.archived ? "archived" : "unarchived"
  }
}

const Status = () => {
  const connection = useAtomValue(connectionAtom)
  const busy = useAtomValue(mutationBusyAtom)

  return (
    <section className="panel status-panel">
      <div className="status-grid">
        <div className={`status-item status-subscription-${connection.subscriptionState}`}>
          <span className="status-label">Subscription</span>
          <strong>{connection.subscriptionState}</strong>
        </div>
        <div className={`status-item ${busy ? "status-mutation-busy" : "status-mutation-idle"}`}>
          <span className="status-label">Mutation</span>
          <strong>{busy ? busy : "idle"}</strong>
        </div>
      </div>
    </section>
  )
}

const TodoPanel = (props: {
  readonly runMutation: MutationRunner
  readonly applyTodoEvent: (event: TodoEvent) => void
}) => {
  const projection = useAtomValue(todoProjectionAtom)
  const connection = useAtomValue(connectionAtom)
  const setProjection = useAtomSet(todoProjectionAtom)
  const renameTodo = useAtomSet(renameTodoMutationAtom, { mode: "promise" })
  const completeTodo = useAtomSet(completeTodoMutationAtom, { mode: "promise" })
  const archiveTodo = useAtomSet(archiveTodoMutationAtom, { mode: "promise" })

  return (
    <section className="panel todo-panel">
      <header className="todo-header">
        <h2>Todos</h2>
        <div className="meta">
          <span>offset #{projection.lastOffset}</span>
          <span>subscription: {connection.subscriptionState}</span>
        </div>
      </header>

      <ul className="todo-list">
        {projection.todos.map((todo) => (
          <li
            key={todo.id}
            className={`todo-item${todo.completed ? " is-completed" : ""}${todo.archived ? " is-archived" : ""}`}
          >
            <div className="todo-main">
              <input
                value={projection.titleDrafts[todo.id] ?? todo.title}
                onChange={(event) => {
                  setProjection((current) => ({
                    ...current,
                    titleDrafts: {
                      ...current.titleDrafts,
                      [todo.id]: event.target.value
                    }
                  }))
                }}
              />
              <small>
                rev {todo.revision} · {new Date(todo.updatedAt).toLocaleTimeString()}
              </small>
            </div>
            <div className="todo-actions">
              <button
                type="button"
                onClick={() =>
                  props.runMutation(
                    `rename:${todo.id}`,
                    () =>
                      renameTodo({
                        payload: {
                          id: todo.id,
                          title: projection.titleDrafts[todo.id] ?? todo.title
                        }
                      }),
                    props.applyTodoEvent
                  )
                }
              >
                Rename
              </button>
              <button
                type="button"
                onClick={() =>
                  props.runMutation(
                    `complete:${todo.id}`,
                    () =>
                      completeTodo({
                        payload: {
                          id: todo.id,
                          completed: !todo.completed
                        }
                      }),
                    props.applyTodoEvent
                  )
                }
              >
                {todo.completed ? "Undo" : "Complete"}
              </button>
              <button
                type="button"
                onClick={() =>
                  props.runMutation(
                    `archive:${todo.id}`,
                    () =>
                      archiveTodo({
                        payload: {
                          id: todo.id,
                          archived: !todo.archived
                        }
                      }),
                    props.applyTodoEvent
                  )
                }
              >
                {todo.archived ? "Unarchive" : "Archive"}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

const EventList = () => {
  const events = useAtomValue(eventsAtom)

  return (
    <section className="panel event-panel">
      <header className="todo-header">
        <h2>Events</h2>
        <div className="meta">
          <span>{events.length} total</span>
        </div>
      </header>

      <ul className="event-list">
        {[...events].reverse().map((event) => (
          <li key={event.offset} className="event-item">
            <div className="event-top">
              <strong>#{event.offset}</strong>
              <span>{new Date(event.at).toLocaleTimeString()}</span>
            </div>
            <div className="event-body">
              <span>{event.todo.title}</span>
              <small>{describeChange(event.change)}</small>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

const Footer = () => {
  const connection = useAtomValue(connectionAtom)

  return (
    <footer className="footer">
      {connection.lastError ? <span className="error">{connection.lastError}</span> : <span>no errors</span>}
    </footer>
  )
}
