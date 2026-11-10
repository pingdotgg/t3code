import { createContext, use } from "react";

export const ActiveNewTaskContext = createContext<{ readonly pendingKey: string | null } | null>(
  null,
);

export function useActiveNewTask() {
  return use(ActiveNewTaskContext);
}
