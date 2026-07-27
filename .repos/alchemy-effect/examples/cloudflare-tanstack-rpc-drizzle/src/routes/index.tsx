import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { createFileRoute } from "@tanstack/react-router";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { useState } from "react";
import {
  createTodoAtom,
  deleteTodoAtom,
  listTodosAtom,
  toggleTodoAtom,
} from "../rpc-client.ts";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "4rem 1.5rem" }}>
      <h1 style={{ margin: 0, fontSize: "2.25rem" }}>Todos</h1>
      <p style={{ marginTop: "0.75rem", color: "#475569", lineHeight: 1.6 }}>
        TanStack Start UI &rarr; <code>AtomRpc</code> client &rarr; Effect RPC
        worker &rarr; Drizzle &rarr; Neon Postgres.
      </p>
      <section style={{ marginTop: "2rem" }}>
        <TodoForm />
        <TodoList />
      </section>
    </main>
  );
}

function TodoForm() {
  const createTodo = useAtomSet(createTodoAtom);

  const [text, setText] = useState("");

  const submit = (e: React.SubmitEvent) => {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    createTodo({ payload: { text: value }, reactivityKeys: ["todos"] });
    setText("");
  };

  return (
    <form onSubmit={submit} style={{ display: "flex", gap: "0.5rem" }}>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What needs doing?"
        style={{
          flex: 1,
          padding: "0.6rem 0.75rem",
          borderRadius: 8,
          border: "1px solid #cbd5e1",
          fontSize: "1rem",
        }}
      />
      <button type="submit" style={primaryButton}>
        Add
      </button>
    </form>
  );
}

function TodoList() {
  const atom = useAtomValue(listTodosAtom);
  const toggleTodo = useAtomSet(toggleTodoAtom);
  const deleteTodo = useAtomSet(deleteTodoAtom);

  const todos = AsyncResult.getOrElse(atom, () => []);

  if (
    (AsyncResult.isWaiting(atom) && !todos.length) ||
    typeof window === "undefined"
  ) {
    return (
      <p style={{ color: "#94a3b8", marginTop: "1.5rem" }}>Loading todos…</p>
    );
  }

  if (!todos.length) {
    return (
      <p style={{ color: "#94a3b8", marginTop: "1.5rem" }}>
        No todos yet — add one above.
      </p>
    );
  }

  return (
    <ul style={{ listStyle: "none", padding: 0, marginTop: "1.5rem" }}>
      {todos.map((todo) => (
        <li
          key={todo.id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.75rem",
            padding: "0.6rem 0",
            borderBottom: "1px solid #e2e8f0",
          }}
        >
          <input
            type="checkbox"
            checked={todo.done}
            onChange={() =>
              toggleTodo({
                payload: { id: todo.id, done: !todo.done },
                reactivityKeys: ["todos"],
              })
            }
            style={{ width: 18, height: 18 }}
          />
          <span
            style={{
              flex: 1,
              textDecoration: todo.done ? "line-through" : "none",
              color: todo.done ? "#94a3b8" : "#0f172a",
            }}
          >
            {todo.text}
          </span>
          <button
            type="button"
            onClick={() =>
              deleteTodo({
                payload: { id: todo.id },
                reactivityKeys: ["todos"],
              })
            }
            style={ghostButton}
          >
            Delete
          </button>
        </li>
      ))}
    </ul>
  );
}

const primaryButton: React.CSSProperties = {
  padding: "0.6rem 1.1rem",
  border: "none",
  borderRadius: 8,
  background: "#0f172a",
  color: "#fff",
  cursor: "pointer",
  fontSize: "1rem",
};

const ghostButton: React.CSSProperties = {
  padding: "0.35rem 0.6rem",
  border: "none",
  borderRadius: 6,
  background: "transparent",
  color: "#ef4444",
  cursor: "pointer",
  fontSize: "0.875rem",
};
