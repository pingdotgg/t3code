import { EnvironmentId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import type { ConnectedEnvironmentSummary } from "../../state/remote-runtime-types";
import {
  applyShowcaseLocalEnvironmentDisplayUrls,
  resolveShowcaseEnvironmentUpdateDisplayUrl,
} from "./showcaseEnvironmentRows";

function environment(
  environmentId: string,
  environmentLabel: string,
  displayUrl = "http://127.0.0.1:3773/",
): ConnectedEnvironmentSummary {
  return {
    environmentId: EnvironmentId.make(environmentId),
    environmentLabel,
    displayUrl,
    isRelayManaged: false,
    isEnabled: true,
    connectionState: "connected",
    connectionError: null,
    connectionErrorTraceId: null,
  };
}

it("leaves environments outside the showcase fixture unchanged", () => {
  const original = environment(
    "runtime-id-4",
    "My Workstation",
    "https://workstation.example.test/",
  );

  assert.deepStrictEqual(applyShowcaseLocalEnvironmentDisplayUrls([original]), [original]);
});

it("does not persist a cosmetic showcase URL when only the label is saved", () => {
  assert.equal(
    resolveShowcaseEnvironmentUpdateDisplayUrl({
      actualDisplayUrl: "http://127.0.0.1:3773/",
      presentedDisplayUrl: "https://moonbase.tail9f3a.ts.net/",
      submittedDisplayUrl: "https://moonbase.tail9f3a.ts.net/",
    }),
    "http://127.0.0.1:3773/",
  );
  assert.equal(
    resolveShowcaseEnvironmentUpdateDisplayUrl({
      actualDisplayUrl: "http://127.0.0.1:3773/",
      presentedDisplayUrl: "https://moonbase.tail9f3a.ts.net/",
      submittedDisplayUrl: "https://new-host.example.com/",
    }),
    "https://new-host.example.com/",
  );
});
