export const SOCKET_USER_ENTRY = "user-entry";
export const SERVICE_USER_WORKER = "user-worker";

/**
 * Default date shared by deployed Workers, framework runners, previews, and
 * internal isolates.
 */
export const DEFAULT_COMPATIBILITY_DATE = "2026-08-31";

export const NODEJS_COMPAT_DEFAULT_ON = "2026-08-04";

/** Apply language and runtime defaults while preserving explicit opt-outs. */
export const withDefaultFlags = (
  flags: Array<string> | undefined,
  {
    date = DEFAULT_COMPATIBILITY_DATE,
    python = flags?.includes("python_workers") ?? false,
    isExternal = true,
    bundle = true,
  }: {
    date?: string;
    python?: boolean;
    isExternal?: boolean;
    bundle?: boolean;
  } = {},
): Array<string> => {
  // Prebuilt external Workers own their runtime configuration. In particular,
  // adopting one with explicit flags must not inject Alchemy's build defaults.
  // See https://github.com/alchemy-run/alchemy/issues/1721.
  if (isExternal && !bundle && flags !== undefined) {
    return [...flags];
  }
  const defaults = new Set(flags);
  if (python) {
    defaults.add("python_workers");
  } else {
    if (!defaults.has("legacy_module_registry")) {
      defaults.add("new_module_registry");
    }
    // Older external workers must not select Node's legacy v1 mode.
    if (
      !defaults.has("no_nodejs_compat") &&
      date < NODEJS_COMPAT_DEFAULT_ON &&
      (!isExternal || date >= "2024-09-23")
    ) {
      defaults.add("nodejs_compat");
    }
  }
  if (!isExternal && date < "2024-10-14") {
    defaults.add("handle_cross_request_promise_resolution");
  }
  return [...defaults];
};

export const defaultDurableObjectUniqueKey = (scriptName: string, className: string) =>
  `${encodeURIComponent(scriptName)}-${encodeURIComponent(className)}`;
