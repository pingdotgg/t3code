// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/* eslint-disable */

declare namespace Cloudflare {
  interface Env {
    ENGINE: DurableObjectNamespace<import("../index.ts").Engine>;
    USER_WORKFLOW: import("cloudflare:workers").WorkflowEntrypoint;
  }
}

declare module "workerd:unsafe" {
  const unsafe: {
    abortAllDurableObjects(): Promise<void>;
  };
  export default unsafe;
}
