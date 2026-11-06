import * as Domain from "@alchemy.run/domain";
import { Notebook } from "./Notebook.aggregate.ts";
import { Notes } from "./Notes.view.ts";

export class NotesModel extends Domain.Model("Notes", {
  aggregates: [Notebook],
  views: [Notes],
}) {}
