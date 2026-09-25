// Client-environment entry. Also imports across the workspace boundary so the
// collector sees the cross-boundary module id in a non-entry environment too.
import { greeting } from "../../lib/src/greeting.ts";

console.log(greeting("client"));
