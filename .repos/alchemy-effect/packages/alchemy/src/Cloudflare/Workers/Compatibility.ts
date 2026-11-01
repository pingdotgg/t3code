import {
  DEFAULT_COMPATIBILITY_DATE,
  NODEJS_COMPAT_DEFAULT_ON,
  withDefaultFlags,
} from "@alchemy.run/cloudflare-runtime/core/internal/constants";
import { isPythonMain } from "./Sources/Python.ts";
import type { WorkerProps } from "./Worker.ts";

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

/**
 * Compatibility settings passed to build tools and framework adapters.
 * Cloudflare rejects a redundant `nodejs_compat` flag after its default-on
 * date, but downstream tools may still detect Node support from the explicit
 * flag only, so internal build configuration materializes the effective flag.
 */
export const getToolingCompatibility = (
  compatibility: { date: string; flags: string[] },
  main: unknown,
) => ({
  date: compatibility.date,
  // TODO: Stop materializing `nodejs_compat` once supported downstream tools
  // consistently derive the default from the compatibility date.
  flags:
    isPythonMain(main) ||
    compatibility.date < NODEJS_COMPAT_DEFAULT_ON ||
    compatibility.flags.includes("nodejs_compat") ||
    compatibility.flags.includes("nodejs_compat_v2") ||
    compatibility.flags.includes("no_nodejs_compat")
      ? compatibility.flags
      : [...compatibility.flags, "nodejs_compat"],
});

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
    flags: withDefaultFlags(props.compatibility?.flags, {
      date,
      python,
      isExternal: props.isExternal ?? false,
      bundle: props.bundle,
    }),
  };
};
