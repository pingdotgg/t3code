import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { isProjectCloneToastSilenced, silenceProjectCloneToasts } from "./projectClones";

it("shows notifications for a new clone attempt on a previously viewed project", () => {
  const ref = scopeProjectRef(EnvironmentId.make("remote"), ProjectId.make("reused-project"));
  const previous = "2026-01-01T00:00:00.000Z";
  const current = "2026-01-01T00:01:00.000Z";

  silenceProjectCloneToasts(ref, previous);
  expect(isProjectCloneToastSilenced(ref, previous)).toBe(true);
  expect(isProjectCloneToastSilenced(ref, current)).toBe(false);

  silenceProjectCloneToasts(ref, current);
  silenceProjectCloneToasts(ref, previous);
  expect(isProjectCloneToastSilenced(ref, current)).toBe(true);
});
