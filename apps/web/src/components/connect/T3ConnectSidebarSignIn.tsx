import * as React from "react";

import { hasCloudPublicConfig } from "../../cloud/publicConfig";

const ConfiguredT3ConnectSidebarSignIn = React.lazy(() =>
  import("./T3ConnectSidebarSignIn.configured").then((module) => ({
    default: module.ConfiguredT3ConnectSidebarSignIn,
  })),
);

const ConfiguredT3ConnectSidebarAvatar = React.lazy(() =>
  import("./T3ConnectSidebarSignIn.configured").then((module) => ({
    default: module.ConfiguredT3ConnectSidebarAvatar,
  })),
);

export function T3ConnectSidebarSignIn() {
  if (!hasCloudPublicConfig()) return null;

  return (
    <React.Suspense fallback={null}>
      <ConfiguredT3ConnectSidebarSignIn />
    </React.Suspense>
  );
}

export function T3ConnectSidebarAvatar() {
  if (!hasCloudPublicConfig()) return null;

  return (
    <React.Suspense fallback={null}>
      <ConfiguredT3ConnectSidebarAvatar />
    </React.Suspense>
  );
}
