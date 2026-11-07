import { createFileRoute } from "@tanstack/react-router";

import { NotesPage } from "../components/notes/NotesPage";

export const Route = createFileRoute("/_chat/notes")({
  component: NotesPage,
});
