import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { shouldShowOpenInPicker } from "./OpenInPicker.logic";

const environmentId = EnvironmentId.make("service");
const primaryEnvironmentId = EnvironmentId.make("desktop");

it.each([
  { primaryEnvironmentId: null, remoteOpenMode: "local-exec", expected: true },
  { primaryEnvironmentId: environmentId, remoteOpenMode: "local-exec", expected: true },
  { primaryEnvironmentId, remoteOpenMode: "local-exec", expected: false },
  { primaryEnvironmentId, remoteOpenMode: "remote-links", expected: true },
] as const)(
  "offers editor opening for $remoteOpenMode with primary $primaryEnvironmentId",
  (input) => {
    expect(
      shouldShowOpenInPicker({
        ...input,
        activeProjectName: "Project",
        activeThreadEnvironmentId: environmentId,
      }),
    ).toBe(input.expected);
  },
);
