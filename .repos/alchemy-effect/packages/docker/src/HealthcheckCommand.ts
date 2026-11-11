/**
 * Renders a healthcheck `cmd` as the single string Docker's `--health-cmd`
 * flag takes. The flag always runs its value through the container's shell, so
 * the Docker API's exec form has to be flattened:
 *
 * - `"cmd"`: used as is.
 * - `["CMD-SHELL", "cmd"]`: the shell command, without the marker.
 * - `["CMD", "pg_isready", "-U", "app"]`: the arguments, each quoted so it
 *   reaches the program as one argument.
 * - `["NONE"]`: no command (the caller disables the healthcheck).
 * - any other array: joined with spaces and run in the shell, as before, so
 *   `["curl -f localhost || exit 1"]` keeps working.
 */
export const healthcheckCommand = (cmd: string[] | string): string | undefined => {
  if (typeof cmd === "string") return cmd;
  const [head, ...rest] = cmd;
  switch (head) {
    case "NONE":
      return undefined;
    case "CMD-SHELL":
      return rest.join(" ");
    case "CMD":
      return rest.map(shellQuote).join(" ");
    default:
      return cmd.join(" ");
  }
};

/** True when `cmd` is Docker's `["NONE"]` form, which disables the healthcheck. */
export const isHealthcheckDisabled = (cmd: string[] | string): boolean =>
  Array.isArray(cmd) && cmd[0] === "NONE";

/** Single-quotes an argument unless it is made only of shell-safe characters. */
const shellQuote = (arg: string): string =>
  /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
