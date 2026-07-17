import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import * as PtyAdapter from "./PtyAdapter.ts";

const isPtySpawnError = Schema.is(PtyAdapter.PtySpawnError);

describe("PtySpawnError", () => {
  it("derives messages from structural context while preserving the full cause chain", () => {
    const spawnCause = new Error("spawn /bin/zsh ENOENT");
    const adapterError = new PtyAdapter.PtySpawnError({
      adapter: "node-pty",
      shell: "/bin/zsh",
      cause: spawnCause,
    });
    const managerError = new PtyAdapter.PtySpawnError({
      adapter: "terminal-manager",
      attemptedShells: ["/bin/zsh -o nopromptsp", "/bin/bash"],
      cause: adapterError,
    });

    assert(isPtySpawnError(managerError));
    assert.strictEqual(
      managerError.message,
      "Failed to spawn PTY process with terminal-manager. Tried shells: /bin/zsh -o nopromptsp, /bin/bash.",
    );
    assert.strictEqual(
      adapterError.message,
      "Failed to spawn PTY process '/bin/zsh' with node-pty.",
    );
    assert.strictEqual(managerError.cause, adapterError);
    assert.strictEqual(adapterError.cause, spawnCause);
  });
});
