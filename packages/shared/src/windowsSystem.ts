// Effect-free so the standalone service launcher can use it.

const windowsSystemRoot = (env: NodeJS.ProcessEnv) => {
  const direct = env.SystemRoot || env.SYSTEMROOT;
  if (direct) return direct;
  let windir: string | undefined;
  for (const key of Object.keys(env)) {
    const value = env[key];
    if (!value) continue;
    const normalized = key.toLowerCase();
    if (normalized === "systemroot") return value;
    if (normalized === "windir" && windir === undefined) windir = value;
  }
  return windir || String.raw`C:\Windows`;
};

/** Windows system tools are run by absolute path, independent of PATH and the working directory. */
export const windowsSystem32Path = (env: NodeJS.ProcessEnv, executable: string) =>
  `${windowsSystemRoot(env)}\\System32\\${executable}`;

export const windowsPowerShellPath = (env: NodeJS.ProcessEnv) =>
  windowsSystem32Path(env, String.raw`WindowsPowerShell\v1.0\powershell.exe`);
