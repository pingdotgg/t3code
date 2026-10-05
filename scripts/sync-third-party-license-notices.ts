// @effect-diagnostics nodeBuiltinImport:off - This is a build-time filesystem script.

import * as NodePath from "node:path";

import { syncThirdPartyLicenseNotices } from "./lib/third-party-licenses.ts";

const configFile = NodePath.resolve("third-party-licenses.config.json");

await syncThirdPartyLicenseNotices(configFile);
