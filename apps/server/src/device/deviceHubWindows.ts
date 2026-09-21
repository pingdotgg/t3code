/** The pinned hub invokes Unix SDK launchers; use their Java entry points on Windows. */
export const deviceHubWindowsPreload = `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
if (process.platform === 'win32') {
  const execFile = childProcess.execFile;
  const invocation = (file, args, ...rest) => {
    const launcher = typeof file === 'string' && /[\\\\/]cmdline-tools[\\\\/]latest[\\\\/]bin[\\\\/](avdmanager|sdkmanager)(?:\\.bat)?$/i.exec(file);
    if (launcher && Array.isArray(args)) {
      const tools = path.dirname(path.dirname(file));
      const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java.exe') : 'java.exe';
      const avd = launcher[1].toLowerCase() === 'avdmanager';
      return [java, ['-Dcom.android.' + (avd ? 'sdkmanager' : 'sdklib') + '.toolsdir=' + tools, '-classpath', path.join(tools, 'lib', launcher[1].toLowerCase() + '-classpath.jar'), avd ? 'com.android.sdklib.tool.AvdManagerCli' : 'com.android.sdklib.tool.sdkmanager.SdkManagerCli', ...args], ...rest];
    }
    return [file, args, ...rest];
  };
  const wrapped = (...args) => execFile(...invocation(...args));
  // The hub promisifies execFile; preserve its stdout/stderr and child handle contract.
  wrapped[promisify.custom] = (...args) => execFile[promisify.custom](...invocation(...args));
  childProcess.execFile = wrapped;
  syncBuiltinESMExports();
}
`;

export const deviceHubWindowsImport = `data:text/javascript;base64,${Buffer.from(deviceHubWindowsPreload).toString("base64")}`;
