import * as os from "node:os"
import * as path from "node:path"
import { mergeConfig, type ViteUserConfig } from "vitest/config"
import shared from "../../vitest.shared.ts"

const config: ViteUserConfig = {
  test: {
    environment: "happy-dom",
    execArgv: [
      "--localstorage-file",
      path.resolve(os.tmpdir(), `vitest-${process.pid}.localstorage`)
    ],
    setupFiles: "./vitest.setup.ts"
  }
}

export default mergeConfig(shared, config)
