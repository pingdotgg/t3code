import * as Domain from "@alchemy.run/domain";
import { NotesModel } from "./Notes.model.ts";

/** What the browser reaches. */
export class NotesApi extends Domain.Api("NotesApi", {
  model: NotesModel,
  commands: ["WriteNote"],
  views: ["Notes"],
}) {}
