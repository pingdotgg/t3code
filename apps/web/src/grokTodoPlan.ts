export interface GrokTodoStep {
  readonly id: string;
  readonly text: string;
  readonly status: "pending" | "running" | "completed" | "cancelled";
}

const UNAPPLIED_STATUSES = new Set(["failed", "cancelled", "interrupted"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isGrokTodoWriteTool(item: {
  readonly title?: string | null;
  readonly toolName?: string | null;
  readonly input?: unknown;
}): boolean {
  return (
    item.title === "Updating plan" ||
    item.toolName === "todo_write" ||
    (isRecord(item.input) && item.input.variant === "TodoWrite")
  );
}

function stepStatus(value: unknown): GrokTodoStep["status"] {
  switch (value) {
    case "completed":
    case "cancelled":
      return value;
    case "in_progress":
      return "running";
    default:
      return "pending";
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function todosOf(value: unknown): unknown {
  const parsed = typeof value === "string" ? parseJson(value) : value;
  if (!isRecord(parsed)) return undefined;
  return isRecord(parsed.TodosUpdated) ? parsed.TodosUpdated.todos : parsed.todos;
}

function stepsFromTodos(todos: unknown): ReadonlyArray<GrokTodoStep> {
  if (!Array.isArray(todos)) return [];
  return todos.flatMap((todo: unknown, index) => {
    if (!isRecord(todo) || typeof todo.content !== "string") return [];
    const text = todo.content.trim();
    if (text.length === 0) return [];
    const id = typeof todo.id === "string" && todo.id.length > 0 ? todo.id : `todo-${index + 1}`;
    return [{ id, text, status: stepStatus(todo.status) }];
  });
}

export function grokTodoStepsFromTool(item: {
  readonly status?: string;
  readonly input?: unknown;
  readonly output?: unknown;
}): ReadonlyArray<GrokTodoStep> {
  const fromOutput = stepsFromTodos(todosOf(item.output));
  if (fromOutput.length > 0 || UNAPPLIED_STATUSES.has(item.status ?? "")) return fromOutput;
  return stepsFromTodos(todosOf(item.input));
}
