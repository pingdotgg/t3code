import * as HostProcess from "../HostProcess.ts";
import { unsetInheritedRepositoryEnv } from "../gitEnvironment.ts";

// Fixtures must discover their own repositories even when tests run from a hook or bisect.
for (const key of Object.keys(
  unsetInheritedRepositoryEnv(process.env, HostProcess.Platform.defaultValue()),
)) {
  delete process.env[key];
}
