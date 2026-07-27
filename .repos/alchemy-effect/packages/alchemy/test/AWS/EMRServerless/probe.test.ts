import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as emr from "@distilled.cloud/aws/emr-serverless";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated platform-gate probe: `emr-serverless:GetResourceDashboard` is
// currently denied by the SERVICE for every caller — even a principal with
// `Action: "*"` (AdministratorAccess) receives
//   AccessDeniedException: User: … is not authorized to perform:
//   emr-serverless:GetResourceDashboard
// with no resource in the message, so the denial is service-side (the
// operation backs the console/interactive-session dashboards), not an IAM
// policy gap. This probe pins that behavior: if it ever starts failing, the
// operation has launched publicly and the Bindings test's expectation for
// the GetResourceDashboard runtime probe should be upgraded to a
// success/not-found assertion.
test.provider(
  "getResourceDashboard is service-gated (typed AccessDenied)",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        emr.getResourceDashboard({
          applicationId: "00abcdefabcdef01",
          resourceId: "00abcdefabcdef01",
          resourceType: "SPARK_DRIVER",
        }),
      );
      expect(error._tag).toBe("AccessDeniedException");
    }),
);
