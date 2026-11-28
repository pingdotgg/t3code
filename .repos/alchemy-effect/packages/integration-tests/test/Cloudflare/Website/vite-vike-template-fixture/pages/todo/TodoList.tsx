import { useState } from "react";
import { useData } from "vike-react/useData";
import type { Data } from "./+data";

export function TodoList() {
  const { todoItemsInitial } = useData<Data>();
  const [todoItems, setTodoItems] = useState<{ text: string }[]>(todoItemsInitial);
  const [newTodo, setNewTodo] = useState("");
  return (
    <>
      <ul>
        {todoItems.map((todoItem, index) => (
          <li key={index}>{todoItem.text}</li>
        ))}
      </ul>
      <div>
        <form
          onSubmit={async (ev) => {
            ev.preventDefault();

            const text = newTodo;
            setTodoItems((prev) => [...prev, { text }]);
            setNewTodo("");
          }}
        >
          <input
            type="text"
            aria-label="New to-do"
            onChange={(ev) => setNewTodo(ev.target.value)}
            value={newTodo}
          />
          <button type="submit">Add to-do</button>
        </form>
      </div>
    </>
  );
}
