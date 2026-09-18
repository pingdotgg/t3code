// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import { ms } from "itty-time";
import type { ResolvedStepConfig, StepState } from "../context.ts";
import type { WorkflowSleepDuration } from "cloudflare:workers";

export class DelayFunctionError extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = "DelayFunctionError";
	}
}

export function calcRetryDuration(
	config: ResolvedStepConfig,
	stepState: StepState,
	delayValue: unknown
): number {
	const { attemptedCount: attemptCount } = stepState;
	const { retries } = config;

	let base: number;
	try {
		base = ms(delayValue as WorkflowSleepDuration);
	} catch {
		throw new DelayFunctionError(
			'returned an invalid delay value (expected a number of ms or a duration string like "30 seconds")'
		);
	}
	if (!Number.isFinite(base) || base < 0) {
		throw new DelayFunctionError(
			'returned an invalid delay value (expected a number of ms or a duration string like "30 seconds")'
		);
	}

	switch (retries.backoff) {
		case "exponential": {
			return base * Math.pow(2, attemptCount - 1);
		}
		case "linear": {
			return base * attemptCount;
		}
		case "constant":
		default: {
			return base;
		}
	}
}
