export interface GrokTodoStep {
  readonly id: string;
  readonly text: string;
  readonly status: "pending" | "running" | "completed" | "cancelled";
}

const TODO_TOOL_NAMES = new Set(["todo_write", "TodoWrite", "Updating plan"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isGrokTodoWriteTool(item: {
  readonly title?: string | null;
  readonly toolName?: string | null;
  readonly input?: unknown;
}): boolean {
  const title = item.title?.trim() ?? "";
  const name = item.toolName?.trim() ?? "";
  if (TODO_TOOL_NAMES.has(title) || TODO_TOOL_NAMES.has(name)) return true;
  return isRecord(item.input) && item.input.variant === "TodoWrite";
}

function stepStatus(value: unknown): GrokTodoStep["status"] {
  switch (value) {
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "in_progress":
    case "inProgress":
    case "running":
      return "running";
    default:
      return "pending";
  }
}

function stepsFromTodos(todos: unknown): ReadonlyArray<GrokTodoStep> | null {
  if (!Array.isArray(todos)) return null;
  const steps: GrokTodoStep[] = [];
  for (const [index, todo] of todos.entries()) {
    if (!isRecord(todo)) continue;
    const text =
      typeof todo.content === "string"
        ? todo.content.trim()
        : typeof todo.text === "string"
          ? todo.text.trim()
          : "";
    if (text.length === 0) continue;
    const id =
      typeof todo.id === "string" && todo.id.trim().length > 0 ? todo.id : `todo-${index + 1}`;
    steps.push({ id, text, status: stepStatus(todo.status) });
  }
  return steps.length > 0 ? steps : null;
}

function todosValue(value: unknown): unknown {
  const parsed = typeof value === "string" ? parseJson(value) : value;
  if (!isRecord(parsed)) return undefined;
  if (Array.isArray(parsed.todos)) return parsed.todos;
  const updated = parsed.TodosUpdated;
  if (isRecord(updated) && Array.isArray(updated.todos)) return updated.todos;
  return undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Prefer `TodosUpdated`. A merge update's arguments often have `content: null`. */
export function grokTodoStepsFromTool(item: {
  readonly input?: unknown;
  readonly output?: unknown;
}): ReadonlyArray<GrokTodoStep> {
  return (
    stepsFromTodos(todosValue(item.output)) ??
    stepsFromTodos(todosValue(item.input)) ??
    stepsFromTodos(isRecord(item.input) ? item.input.todos : undefined) ??
    []
  );
}
