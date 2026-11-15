// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import Plist, { type PlistObject } from "plist";

interface AfterPackContext {
  readonly appOutDir: string;
  readonly packager: { readonly appInfo: { readonly productFilename: string } };
}

const prepareServerCompileCache: (context: AfterPackContext) => Promise<void> =
  NodeModule.createRequire(import.meta.url)("./prepare-server-compile-cache.cjs");

// electron-builder takes one afterPack hook, so the macOS hook also runs the shared one.
export default async function afterPack(context: AfterPackContext): Promise<void> {
  const product = context.packager.appInfo.productFilename;
  copyUsageDescriptionsToHelper(NodePath.join(context.appOutDir, `${product}.app`), product);
  await prepareServerCompileCache(context);
}

// macOS takes privacy prompt text from the responsible app, which for agent commands is the
// Helper the backend runs as. Electron and electron-builder give the Helper none.
export function copyUsageDescriptionsToHelper(appBundlePath: string, executable: string): void {
  const contents = NodePath.join(appBundlePath, "Contents");
  const helperPath = NodePath.join(
    contents,
    `Frameworks/${executable} Helper.app/Contents/Info.plist`,
  );
  const read = (path: string) => Plist.parse(NodeFS.readFileSync(path, "utf8")) as PlistObject;
  const usageDescriptions = Object.entries(read(NodePath.join(contents, "Info.plist"))).filter(
    ([key]) => /^NS\w+UsageDescription$/.test(key),
  );
  NodeFS.writeFileSync(
    helperPath,
    Plist.build({ ...read(helperPath), ...Object.fromEntries(usageDescriptions) }),
  );
}
