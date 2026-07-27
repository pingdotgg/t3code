import { isPythonMain } from "./PythonWorkerBundle.ts";
import type { WorkerProps } from "./Worker.ts";

// TODO: figure out why the later one from workerd breaks
const DEFAULT_COMPATIBILITY_DATE = "2026-03-17";

/**
 * The Effect worker bridge builds its layer stack once per isolate and shares
 * the in-flight build promise across concurrent events. Awaiting a promise
 * created under another event's request context is only sound with workerd's
 * corrected cross-request promise semantics (default-on since compatibility
 * date 2024-10-14): continuations are scheduled back into the promise's
 * origin context instead of running in whichever request happens to resolve
 * them. A user pinning an older compatibility date must not silently revert
 * the bridge to the broken semantics, so the flag is forced for
 * alchemy-bundled workers — and explicitly disabling it is a deploy-time
 * error.
 */
const CROSS_REQUEST_PROMISE_RESOLUTION =
  "handle_cross_request_promise_resolution";

// The date the flag became default-on. Cloudflare rejects a script that
// specifies a flag its compatibility date already defaults on ("does not
// need to be specified anymore"), so it is only appended for older dates.
const CROSS_REQUEST_PROMISE_RESOLUTION_DEFAULT_ON = "2024-10-14";

export const getCompatibility = (props: WorkerProps) => {
  const userFlags = props.compatibility?.flags ?? [];
  const python = isPythonMain(props.main);
  if (python && !props.isExternal) {
    throw new Error(
      "Python Workers cannot have an inline Effect implementation: the " +
        "Effect runtime is a JavaScript bundle and cannot be injected into " +
        "a Pyodide Worker. Declare the Worker with only its props (the " +
        "handlers live in the Python entry module).",
    );
  }
  if (
    !props.isExternal &&
    userFlags.includes(`no_${CROSS_REQUEST_PROMISE_RESOLUTION}`)
  ) {
    throw new Error(
      `The "no_${CROSS_REQUEST_PROMISE_RESOLUTION}" compatibility flag is not supported: ` +
        "the alchemy Worker runtime shares its layer build across concurrent " +
        "requests, which requires workerd's corrected cross-request promise " +
        "semantics. Remove the flag from `compatibility.flags`.",
    );
  }
  const date = props.compatibility?.date ?? DEFAULT_COMPATIBILITY_DATE;
  return {
    date,
    flags: [
      ...userFlags,
      // Required while Python Workers are in open beta — the upload API
      // rejects Python modules without it.
      ...(python ? ["python_workers"] : []),
      ...(props.isExternal
        ? []
        : [
            "nodejs_compat",
            // ISO dates compare lexically.
            ...(date < CROSS_REQUEST_PROMISE_RESOLUTION_DEFAULT_ON
              ? [CROSS_REQUEST_PROMISE_RESOLUTION]
              : []),
          ]),
    ].filter((value, index, self) => self.indexOf(value) === index),
  };
};
