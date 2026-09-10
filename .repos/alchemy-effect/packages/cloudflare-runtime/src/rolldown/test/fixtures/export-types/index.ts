import { getExportTypes } from "distilled:export-types";
import * as entry from "./entry.ts";

export default {
  fetch: () => Response.json(getExportTypes(entry)),
};
