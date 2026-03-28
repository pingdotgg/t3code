import { resolve } from "node:path";

import { syncWorkspaceLinks } from "./lib/workspace-links.mjs";

await syncWorkspaceLinks(resolve(import.meta.dirname, ".."));
