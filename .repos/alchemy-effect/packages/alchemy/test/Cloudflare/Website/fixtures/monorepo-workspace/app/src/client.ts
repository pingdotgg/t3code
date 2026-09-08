// Client-environment entry. Also imports across the workspace boundary so
// the cross-boundary module id shows up in a non-entry environment too.
import { greeting } from "../../lib/src/greeting.ts";

console.log(greeting("client"));
