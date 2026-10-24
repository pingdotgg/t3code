#!/usr/bin/env node
// Stops the dev server a run-row/stills invocation started: node stop.mjs <label> [outDir]
import * as NodePath from "node:path";
import { stopServer } from "./server.mjs";
const [label, outDir = "/tmp/ev-22193"] = process.argv.slice(2);
await stopServer(NodePath.join(outDir, `${label}.pgid`));
