import { fileURLToPath } from "node:url";
// Relative imports let the fixture run under both Bun and Node.
import * as Effect from "effect/Effect";
import { launch } from "../../../src/Local/RpcServer.ts";
import { makeEcho } from "./rpc-echo.ts";

const TestEchoLive = makeEcho();
export default TestEchoLive;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  launch((group) => Effect.succeed(group.endsWith("#blocked") ? makeEcho(true) : TestEchoLive));
}
