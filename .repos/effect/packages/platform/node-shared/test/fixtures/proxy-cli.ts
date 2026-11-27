// The entry point of a packaged application, which dispatches its private
// subcommand before it loads the application
import { syncBuiltinESMExports } from "node:module"
import Vm from "node:vm"

// The test runs this under --disallow-code-generation-from-strings, which
// does not restrict node:vm, so the proxy process must not use it either
const forbidden = () => {
  throw new Error("The proxy process compiled code at runtime")
}
Vm.runInThisContext = forbidden
Vm.Script = forbidden as unknown as typeof Vm.Script
syncBuiltinESMExports()

if (process.argv[2] === "__proxy-process") {
  const { run } = await import("@effect/platform-node-shared/NodeChildProcessProxy")
  run()
} else {
  throw new Error("The proxy process must not load the application")
}
