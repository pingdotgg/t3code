// Effect-free so the standalone service launcher can use it.

/** Windows system tools are run by absolute path, independent of PATH and the working directory. */
export const windowsSystem32Path = (env: NodeJS.ProcessEnv, executable: string) =>
  `${env.SystemRoot || env.SYSTEMROOT || env.windir || String.raw`C:\Windows`}\\System32\\${executable}`;

export const windowsPowerShellPath = (env: NodeJS.ProcessEnv) =>
  windowsSystem32Path(env, String.raw`WindowsPowerShell\v1.0\powershell.exe`);
