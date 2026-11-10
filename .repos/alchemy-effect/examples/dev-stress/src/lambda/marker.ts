/**
 * Marker read by `ApiFunction`, whose module the STACK imports. Rewriting
 * it re-runs the stack and hot-swaps the Lambda's code inside the floci
 * emulator without a redeploy.
 */
export const LAMBDA_MARKER = "lambda-v1";
