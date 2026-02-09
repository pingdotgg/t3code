import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  type NewTodoInput,
  type Todo,
  newTodoInputSchema,
  todoIdSchema,
  todoListSchema,
} from "@acme/contracts";

export class TodoStore {
  private todos: Todo[] = [];
  private queue: Promise<void> = Promise.resolve();

  public constructor(private readonly filePath: string) {}

  public async init(): Promise<void> {
    return this.runExclusive(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });

      try {
        const raw = await fs.readFile(this.filePath, "utf8");
        const parsed = todoListSchema.safeParse(JSON.parse(raw));

        if (parsed.success) {
          this.todos = parsed.data;
          return;
        }
      } catch (error) {
        if (!isNotFoundError(error)) {
          throw error;
        }
      }

      this.todos = [];
      await this.persist();
    });
  }

  public async list(): Promise<Todo[]> {
    return this.runExclusive(async () => [...this.todos]);
  }

  public async add(input: NewTodoInput): Promise<Todo[]> {
    return this.runExclusive(async () => {
      const { title } = newTodoInputSchema.parse(input);
      const todo: Todo = {
        id: randomUUID(),
        title,
        completed: false,
        createdAt: new Date().toISOString(),
      };

      this.todos = [todo, ...this.todos];
      await this.persist();
      return [...this.todos];
    });
  }

  public async toggle(id: string): Promise<Todo[]> {
    return this.runExclusive(async () => {
      const parsedId = todoIdSchema.parse(id);
      this.todos = this.todos.map((todo) =>
        todo.id === parsedId ? { ...todo, completed: !todo.completed } : todo,
      );

      await this.persist();
      return [...this.todos];
    });
  }

  public async remove(id: string): Promise<Todo[]> {
    return this.runExclusive(async () => {
      const parsedId = todoIdSchema.parse(id);
      this.todos = this.todos.filter((todo) => todo.id !== parsedId);

      await this.persist();
      return [...this.todos];
    });
  }

  private async persist(): Promise<void> {
    await fs.writeFile(this.filePath, JSON.stringify(this.todos, null, 2), "utf8");
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );

    return next;
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
