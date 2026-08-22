import {
  StartHookForm,
  type StartHookFormComponent,
  StartHookPollState,
  type StartHookSelectComponent,
  type StartHookTextComponent,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

// Client side of the start hook protocol (see contracts/instanceHooks.ts).
// The management endpoint is a third-party origin, so it must allow CORS for
// the app origin; a preflight failure surfaces here as a network error.

const decodePollState = Schema.decodeUnknownSync(StartHookPollState);
const decodeForm = Schema.decodeUnknownSync(StartHookForm);

const MIN_POLL_INTERVAL_MS = 1_000;
const MAX_POLL_INTERVAL_MS = 60_000;
const POLL_DEADLINE_MS = 10 * 60_000;

export type StartHookStep =
  | { readonly kind: "ready" }
  | { readonly kind: "poll"; readonly poll: StartHookPollState }
  | { readonly kind: "form"; readonly form: StartHookForm };

/**
 * Messages are derived from structural facts only. Underlying failures and
 * third-party response text stay on `cause` so they never reach a toast.
 */
export class StartHookError extends Error {}

export type StartHookInputComponent = StartHookSelectComponent | StartHookTextComponent;

export function isStartHookInputComponent(
  component: StartHookFormComponent,
): component is StartHookInputComponent {
  return "type" in component;
}

export function validateStartHookTextInput(
  component: StartHookTextComponent,
  value: string,
): string | null {
  let pattern: RegExp;
  try {
    pattern = new RegExp(component.regex);
  } catch {
    // An unparsable pattern is the management solution's bug; do not let it
    // lock the user out of starting the instance.
    return null;
  }
  return pattern.test(value) ? null : component.validationError;
}

export interface StartHookRequestOptions {
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly now?: () => number;
}

function resolveFetch(options: StartHookRequestOptions): typeof fetch {
  return options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
}

async function interpretStartHookResponse(response: Response): Promise<StartHookStep> {
  if (response.status === 204) {
    return { kind: "ready" };
  }
  let body: unknown;
  const readBody = async () => {
    try {
      body = await response.json();
    } catch (error) {
      throw new StartHookError(
        `The start hook returned status ${response.status} without a readable JSON body.`,
        { cause: error },
      );
    }
  };
  if (response.status === 200) {
    await readBody();
    try {
      return { kind: "poll", poll: decodePollState(body) };
    } catch (error) {
      throw new StartHookError("The start hook returned a malformed poll response.", {
        cause: error,
      });
    }
  }
  if (response.status === 400) {
    await readBody();
    try {
      return { kind: "form", form: decodeForm(body) };
    } catch (error) {
      throw new StartHookError("The start hook returned a malformed form response.", {
        cause: error,
      });
    }
  }
  throw new StartHookError(`The start hook responded with unexpected status ${response.status}.`);
}

async function postStartHook(
  url: string,
  body: string | null,
  options: StartHookRequestOptions,
): Promise<StartHookStep> {
  const fetchImpl = resolveFetch(options);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      signal: options.signal ?? null,
      ...(body === null ? {} : { body, headers: { "content-type": "application/json" } }),
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new StartHookError("Could not reach the start hook.", { cause: error });
  }
  return interpretStartHookResponse(response);
}

/** POST the start hook with no content, per the protocol's opening request. */
export function requestStartHook(
  url: string,
  options: StartHookRequestOptions = {},
): Promise<StartHookStep> {
  return postStartHook(url, null, options);
}

/**
 * POST the resolved component values back as a JSON array, in component
 * order, input components only.
 */
export function submitStartHookForm(
  url: string,
  values: ReadonlyArray<string>,
  options: StartHookRequestOptions = {},
): Promise<StartHookStep> {
  return postStartHook(url, JSON.stringify(values), options);
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/**
 * Poll until the instance reports ready with a 204. Any error status fails
 * the run; the management endpoint signals "still starting" with a non-204
 * success response.
 */
export async function pollStartHookUntilReady(
  poll: StartHookPollState,
  options: StartHookRequestOptions = {},
): Promise<void> {
  const fetchImpl = resolveFetch(options);
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const intervalMs = Math.min(
    Math.max(poll.retry_secs * 1_000, MIN_POLL_INTERVAL_MS),
    MAX_POLL_INTERVAL_MS,
  );
  // Wall-clock deadline so slow poll requests count against it too.
  const deadlineAt = now() + POLL_DEADLINE_MS;
  while (true) {
    let response: Response;
    try {
      response = await fetchImpl(poll.poll_url, { method: "GET", signal: options.signal ?? null });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new StartHookError("Could not poll the start hook.", { cause: error });
    }
    if (response.status === 204) {
      return;
    }
    // Only a plain 200 means "still starting". Anything else — an error, a
    // redirect, a 304 — is a misconfigured endpoint, not progress.
    if (response.status !== 200) {
      throw new StartHookError(`Polling the start hook failed with status ${response.status}.`);
    }
    if (now() + intervalMs > deadlineAt) {
      throw new StartHookError("The instance did not report ready in time.");
    }
    await sleep(intervalMs, options.signal);
  }
}
