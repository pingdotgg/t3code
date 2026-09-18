// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import { InstanceEvent } from "../instance.ts";
import { WorkflowFatalError } from "./errors.ts";
import { isValidStepConfig } from "./validators.ts";
import type { WorkflowStepContext } from "../context.ts";
import type { Engine } from "../engine.ts";
import type { WorkflowStepConfig } from "cloudflare:workers";

type UserErrorField = {
	isUserError?: boolean;
};

// `:` can't appear in user-step cacheKeys (sha1-hex + `-` only).
export const ROLLBACK_CACHE_KEY_PREFIX = "rollback:";

export type RollbackContext = {
	ctx: WorkflowStepContext;
	error: Error;
	output: unknown;
	/** @deprecated Use `${ctx.step.name}-${ctx.step.count}` instead. */
	stepName: string;
};

// dup() to outlive the originating step.do call; Symbol.dispose locally
// (calling `.dispose()` would RPC to a non-existent remote method).
export type RollbackFn = ((ctx: RollbackContext) => Promise<void>) & {
	dup?: () => RollbackFn;
	[Symbol.dispose]?: () => void;
};

export type WorkflowStepRollbackConfig = Pick<
	WorkflowStepConfig,
	"retries" | "timeout"
>;

export type WorkflowStepRollbackOptions = {
	rollback: RollbackFn;
	rollbackConfig?: WorkflowStepRollbackConfig;
};

export type RollbackRegistryEntry = {
	fn: RollbackFn;
	stepContext: WorkflowStepContext;
	output?: unknown;
	config?: WorkflowStepConfig;
};

export type RollbackRegistration = RollbackRegistryEntry & {
	cacheKey: string;
};

export function parseRollbackOptions(
	stepName: string,
	options: unknown
): WorkflowStepRollbackOptions | undefined {
	if (options === undefined) {
		return undefined;
	}

	if (
		typeof options !== "object" ||
		options === null ||
		Array.isArray(options)
	) {
		const error = new WorkflowFatalError(
			`Rollback options for "${stepName}" must be an object`
		) as Error & UserErrorField;
		error.isUserError = true;
		throw error;
	}

	const rollbackOptions = options as Partial<WorkflowStepRollbackOptions>;
	if (typeof rollbackOptions.rollback !== "function") {
		const error = new WorkflowFatalError(
			`Rollback for "${stepName}" must be a function`
		) as Error & UserErrorField;
		error.isUserError = true;
		throw error;
	}

	if (
		rollbackOptions.rollbackConfig !== undefined &&
		!isValidStepConfig(rollbackOptions.rollbackConfig)
	) {
		const error = new WorkflowFatalError(
			`Rollback config for "${stepName}" is in a invalid format. See https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/`
		) as Error & UserErrorField;
		error.isUserError = true;
		throw error;
	}

	return rollbackOptions as WorkflowStepRollbackOptions;
}

export function dupRollbackStub(fn: RollbackFn): RollbackFn {
	return fn.dup ? fn.dup() : fn;
}

export function disposeRollbackStub(fn: RollbackFn): void {
	try {
		fn[Symbol.dispose]?.();
	} catch (err) {
		console.warn("Failed to dispose rollback stub", err);
	}
}

export function registerRollbackFn(
	registry: Map<string, RollbackRegistryEntry>,
	registration: RollbackRegistration
): void {
	const { cacheKey, fn, stepContext, output, config } = registration;
	const existing = registry.get(cacheKey);
	if (existing) {
		// Existing entry already owns the duped rollback stub. Duplicate registrations
		// refresh context/output only; this helper has not duped the incoming fn.
		registry.set(cacheKey, {
			...existing,
			stepContext,
			...("output" in registration && { output }),
		});
		return;
	}
	registry.set(cacheKey, {
		fn: dupRollbackStub(fn),
		stepContext,
		...("output" in registration && { output }),
		...(config !== undefined && { config }),
	});
}

export function clearRollbackRegistry(
	registry: Map<string, RollbackRegistryEntry>
): void {
	for (const entry of registry.values()) {
		disposeRollbackStub(entry.fn);
	}
	registry.clear();
}

// LIFO; halts on first failure. Goes through Context.do so each rollback
// inherits retries/timeouts/attempt-logging.
export async function executeRollbacks(
	engine: Engine,
	triggerError: Error
): Promise<{ ranAny: boolean; allSucceeded: boolean }> {
	const eligibleSteps = engine.readEligibleRollbackStepsDesc();
	if (eligibleSteps.length === 0) {
		clearRollbackRegistry(engine.rollbackRegistry);
		return { ranAny: false, allSucceeded: true };
	}

	engine.writeLog(InstanceEvent.ROLLBACK_START, null, null, {
		triggerError: { name: triggerError.name, message: triggerError.message },
		totalSteps: eligibleSteps.length,
	});

	let allSucceeded = true;
	let completed = 0;

	try {
		for (const step of eligibleSteps) {
			const entry = engine.rollbackRegistry.get(step.cacheKey);
			if (entry === undefined) {
				engine.writeLog(
					InstanceEvent.ROLLBACK_STEP_FAILURE,
					step.cacheKey,
					step.target,
					{
						error: {
							name: "RollbackMissing",
							message: "Rollback function not available in registry",
						},
					}
				);
				allSucceeded = false;
				break;
			}

			const ctx = engine.createRollbackContext({ cacheKey: step.cacheKey });
			try {
				await ctx.do(step.target, entry.config ?? {}, async () => {
					await entry.fn({
						ctx: structuredClone(entry.stepContext),
						error: triggerError,
						output: entry.output,
						stepName: step.target,
					});
				});
				completed++;
			} catch {
				// Context.do already wrote ROLLBACK_STEP_FAILURE; halt the chain.
				allSucceeded = false;
				break;
			} finally {
				disposeRollbackStub(entry.fn);
				engine.rollbackRegistry.delete(step.cacheKey);
			}
		}
	} finally {
		clearRollbackRegistry(engine.rollbackRegistry);
	}

	engine.writeLog(
		allSucceeded
			? InstanceEvent.ROLLBACK_COMPLETE
			: InstanceEvent.ROLLBACK_FAILED,
		null,
		null,
		{ totalSteps: eligibleSteps.length, completedSteps: completed }
	);
	return { ranAny: completed > 0, allSucceeded };
}
