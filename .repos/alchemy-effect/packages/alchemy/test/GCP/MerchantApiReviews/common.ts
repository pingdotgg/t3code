import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const accountId =
  process.env.GCP_MERCHANTAPI_ACCOUNT_ID?.trim() ||
  process.env.GCP_CONTENT_MERCHANT_ID?.trim() ||
  undefined;

const sharedDataSource = process.env.GCP_MERCHANTAPI_DATA_SOURCE?.trim();

export const merchantReviewDataSource =
  process.env.GCP_MERCHANTAPI_MERCHANT_REVIEW_DATA_SOURCE?.trim() ||
  sharedDataSource;

export const productReviewDataSource =
  process.env.GCP_MERCHANTAPI_PRODUCT_REVIEW_DATA_SOURCE?.trim() ||
  sharedDataSource;

export const runMerchantReviewLifecycle =
  !process.env.FAST && !!accountId && !!merchantReviewDataSource;

export const runProductReviewLifecycle =
  !process.env.FAST && !!accountId && !!productReviewDataSource;

export const probeAccount = accountId ?? "1";

export const probeDataSource = (dataSource: string | undefined) =>
  dataSource ?? `accounts/${probeAccount}/dataSources/1`;
