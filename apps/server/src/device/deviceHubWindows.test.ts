// @effect-diagnostics nodeBuiltinImport:off - executes the hub preload in an isolated Node process.
import { expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import { deviceHubWindowsImport } from "./deviceHubWindows.ts";

it("adapts Windows SDK launchers while preserving execFile callbacks and promises", () => {
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
import cp from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
import path from 'node:path';
Object.defineProperty(process, 'platform', {value:'win32'});
process.env.JAVA_HOME = 'C:/Java runtime';
const calls=[];
const fake=(...args)=>{calls.push(args.slice(0,2));args.at(-1)(null,'out','err');return {pid:123};};
fake[promisify.custom]=(...args)=>{calls.push(args.slice(0,2));const p=Promise.resolve({stdout:'out',stderr:'err'});p.child={pid:123};return p;};
cp.execFile=fake;
await import(${JSON.stringify(deviceHubWindowsImport)});
const sdk='C:/Android SDK/cmdline-tools/latest';
const unsafe=['create','avd','--name','spaces & %PATH% "quotes"'];
const child=cp.execFile(sdk+'/bin/avdmanager',unsafe,(error,out,err)=>{assert.equal(error,null);assert.equal(out,'out');assert.equal(err,'err');});
assert.equal(child.pid,123);
const pending=promisify(cp.execFile)(sdk+'/bin/sdkmanager.bat',['--list_installed'],{timeout:123});
assert.equal(pending.child.pid,123);
assert.deepEqual(await pending,{stdout:'out',stderr:'err'});
assert.equal(calls[0][0],path.join(process.env.JAVA_HOME,'bin','java.exe'));
assert.deepEqual(calls[0][1],['-Dcom.android.sdkmanager.toolsdir='+sdk,'-classpath',path.join(sdk,'lib','avdmanager-classpath.jar'),'com.android.sdklib.tool.AvdManagerCli',...unsafe]);
assert.deepEqual(calls[1][1],['-Dcom.android.sdklib.toolsdir='+sdk,'-classpath',path.join(sdk,'lib','sdkmanager-classpath.jar'),'com.android.sdklib.tool.sdkmanager.SdkManagerCli','--list_installed']);
await promisify(cp.execFile)('adb',['devices']);
assert.deepEqual(calls[2],['adb',['devices']]);
`,
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});
