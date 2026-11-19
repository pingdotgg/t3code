import * as HostProcess from "../HostProcess.ts";
import { unsetInheritedRepositoryEnv } from "../gitEnvironment.ts";

// A test run started from `git bisect run`, `git rebase --exec` or a hook inherits GIT_DIR. Every git
// command a test or the code under test starts would then write into that repository.
for (const name of Object.keys(
  unsetInheritedRepositoryEnv(process.env, HostProcess.Platform.defaultValue()),
)) {
  delete process.env[name];
}
