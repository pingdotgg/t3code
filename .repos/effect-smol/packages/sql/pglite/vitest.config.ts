import { mergeConfig, type ViteUserConfig } from "vitest/config"
import shared from "../../../vitest.shared.ts"

const config: ViteUserConfig = {}

export default mergeConfig(shared, config)
