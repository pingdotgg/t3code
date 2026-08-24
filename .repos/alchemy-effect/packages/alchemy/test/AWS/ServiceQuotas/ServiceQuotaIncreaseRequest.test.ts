import * as AWS from "@/AWS";
import { ServiceQuotaIncreaseRequest } from "@/AWS/ServiceQuotas";
import * as Test from "@/Test/Alchemy";
import * as servicequotas from "@distilled.cloud/aws/service-quotas";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// VPCs per region (default 5) and Subnets per VPC (default 200) — both
// always exist, so a desiredValue of 1 is always already satisfied and the
// reconciler never submits a real increase request.
const VPCS_PER_REGION = "L-F678F1CE";
const SUBNETS_PER_VPC = "L-407747CB";

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag this provider's observe/read paths depend on. Runs in every
// CI pass at near-zero cost, unlike the gated live increase below.
test.provider(
  "getServiceQuota with a bogus quota code fails with NoSuchResourceException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        servicequotas.getServiceQuota({
          ServiceCode: "vpc",
          QuotaCode: "L-00000000",
        }),
      );
      expect(error._tag).toBe("NoSuchResourceException");
    }),
);

// Full engine lifecycle on the SAFE path: a desired value at or below the
// applied quota is already satisfied, so no real increase request (and no
// support case) is ever opened. Covers create, no-op update, and
// replacement (quotaCode change).
test.provider(
  "already-satisfied desired value deploys without submitting a request",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployQuota = (quotaCode: string, desiredValue: number) =>
        stack.deploy(
          Effect.gen(function* () {
            const request = yield* ServiceQuotaIncreaseRequest("VpcQuota", {
              serviceCode: "vpc",
              quotaCode,
              desiredValue,
            });
            return { request };
          }),
        );

      // 1. Create — satisfied, so no request is submitted.
      const { request } = yield* deployQuota(VPCS_PER_REGION, 1);
      expect(request.serviceCode).toBe("vpc");
      expect(request.quotaCode).toBe(VPCS_PER_REGION);
      expect(request.desiredValue).toBe(1);
      expect(request.requestId).toBeUndefined();
      expect(request.status).toBeUndefined();
      // The VPCs-per-region quota defaults to 5 — always >= 1.
      expect(request.appliedValue).toBeGreaterThanOrEqual(1);
      expect(request.quotaName).toBeDefined();

      // 2. Update desiredValue (still satisfied) — default update path, no
      //    request submitted.
      const second = yield* deployQuota(VPCS_PER_REGION, 2);
      expect(second.request.desiredValue).toBe(2);
      expect(second.request.requestId).toBeUndefined();

      // 3. Replacement — quotaCode change replaces the resource. Still
      //    satisfied (Subnets per VPC defaults to 200), so still no request.
      const third = yield* deployQuota(SUBNETS_PER_VPC, 1);
      expect(third.request.quotaCode).toBe(SUBNETS_PER_VPC);
      expect(third.request.requestId).toBeUndefined();
      expect(third.request.appliedValue).toBeGreaterThanOrEqual(1);

      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

// Submitting a REAL quota increase request may open an AWS Support case and
// cannot be cancelled via the API — gated behind AWS_TEST_SERVICE_QUOTAS=1.
test.provider.skipIf(!process.env.AWS_TEST_SERVICE_QUOTAS)(
  "submits a real quota increase request and adopts it on re-deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Observe the current applied value out-of-band so the requested
      // value is always strictly above it (AWS rejects <= applied).
      const current = yield* servicequotas
        .getServiceQuota({
          ServiceCode: "vpc",
          QuotaCode: VPCS_PER_REGION,
        })
        .pipe(
          Effect.map((r) => r.Quota?.Value),
          Effect.catchTag("NoSuchResourceException", () =>
            servicequotas
              .getAWSDefaultServiceQuota({
                ServiceCode: "vpc",
                QuotaCode: VPCS_PER_REGION,
              })
              .pipe(Effect.map((r) => r.Quota?.Value)),
          ),
        );
      const desiredValue = Math.ceil(current ?? 5) + 1;

      const deployIncrease = stack.deploy(
        Effect.gen(function* () {
          const request = yield* ServiceQuotaIncreaseRequest("VpcIncrease", {
            serviceCode: "vpc",
            quotaCode: VPCS_PER_REGION,
            desiredValue,
          });
          return { request };
        }),
      );

      const { request } = yield* deployIncrease;
      expect(request.requestId).toBeDefined();
      expect(["PENDING", "CASE_OPENED", "APPROVED"]).toContain(request.status);
      expect(request.desiredValue).toBe(desiredValue);

      // Out-of-band verification via distilled.
      const observed = yield* servicequotas.getRequestedServiceQuotaChange({
        RequestId: request.requestId!,
      });
      expect(observed.RequestedQuota?.QuotaCode).toBe(VPCS_PER_REGION);
      expect(observed.RequestedQuota?.DesiredValue).toBe(desiredValue);

      // Idempotency: a second deploy converges on the SAME open request
      // instead of submitting a duplicate.
      const second = yield* deployIncrease;
      expect(second.request.requestId).toBe(request.requestId);

      // Destroy only forgets the request — Service Quotas has no cancel API.
      yield* stack.destroy();
    }),
  { timeout: 180_000 },
);
