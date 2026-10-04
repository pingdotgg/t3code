import { createFileRoute } from "@tanstack/react-router";
import { TasksPage } from "../components/tasks/TasksPage";
export const Route = createFileRoute("/tasks")({ component: TasksPage });
