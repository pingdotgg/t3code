import * as licensing from "@distilled.cloud/gcp/licensing_v1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// License Manager needs a Workspace credential with the apps.licensing OAuth
// scope (a Cloud Platform service-account token is rejected with
// InsufficientAuthenticationScopes) and a user to license; set
// GCP_TEST_LICENSING=1 and GOOGLE_LICENSE_USER_ID when both hold.
export const runLifecycle =
  !process.env.FAST &&
  process.env.GCP_TEST_LICENSING === "1" &&
  !!process.env.GOOGLE_LICENSE_USER_ID;

export const productId = process.env.GOOGLE_LICENSE_PRODUCT_ID ?? "Google-Apps";
export const skuId =
  process.env.GOOGLE_LICENSE_SKU_ID ?? "Google-Apps-For-Business";
export const updateSkuId =
  process.env.GOOGLE_LICENSE_SKU_ID_UPDATE ?? "Google-Apps-Unlimited";
export const userId =
  process.env.GOOGLE_LICENSE_USER_ID ?? "alchemy-missing@example.com";
export const customerId =
  process.env.GOOGLE_LICENSE_CUSTOMER_ID ??
  process.env.GOOGLE_WORKSPACE_CUSTOMER_ID ??
  "my_customer";

export const missingUserId = "alchemy-missing@example.com";

export const waitUntilGone = (
  assignment: Pick<
    licensing.LicenseAssignment,
    "productId" | "skuId" | "userId"
  >,
) =>
  licensing
    .getLicenseAssignments({
      productId: assignment.productId ?? productId,
      skuId: assignment.skuId ?? skuId,
      userId: assignment.userId ?? userId,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );
