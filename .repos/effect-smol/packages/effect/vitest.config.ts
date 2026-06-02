import { mergeConfig } from "vitest/config"
import shared from "../../vitest.shared.ts"

const isDeno = process.versions.deno !== undefined

export default mergeConfig(shared, {
  test: {
    // @see https://github.com/denoland/deno/issues/23882
    exclude: (isDeno ? ["test/cluster/**"] : [])
  }
})
