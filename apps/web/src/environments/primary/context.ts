import type { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { PrimaryEnvironmentRequestError, retryTransientBootstrap } from "./auth";
import { PrimaryEnvironmentHttpClient } from "./httpClient";

import { runPrimaryHttp } from "../../lib/runtime";

let primaryEnvironmentDescriptor: ExecutionEnvironmentDescriptor | null = null;
let primaryEnvironmentDescriptorPromise: Promise<ExecutionEnvironmentDescriptor> | null = null;

async function fetchPrimaryEnvironmentDescriptor(): Promise<ExecutionEnvironmentDescriptor> {
  return retryTransientBootstrap(async () => {
    let descriptor: ExecutionEnvironmentDescriptor;
    try {
      descriptor = await runPrimaryHttp(
        PrimaryEnvironmentHttpClient.pipe(Effect.flatMap((client) => client.metadata.descriptor())),
      );
    } catch (error) {
      throw PrimaryEnvironmentRequestError.fromCause({
        operation: "fetch-environment-descriptor",
        cause: error,
      });
    }

    writePrimaryEnvironmentDescriptor(descriptor);
    return descriptor;
  });
}

function readPrimaryEnvironmentDescriptor(): ExecutionEnvironmentDescriptor | null {
  return primaryEnvironmentDescriptor;
}

function writePrimaryEnvironmentDescriptor(
  descriptor: ExecutionEnvironmentDescriptor | null,
): void {
  primaryEnvironmentDescriptor = descriptor;
}

export function resolveInitialPrimaryEnvironmentDescriptor(): Promise<ExecutionEnvironmentDescriptor> {
  const descriptor = readPrimaryEnvironmentDescriptor();
  if (descriptor) {
    return Promise.resolve(descriptor);
  }

  if (primaryEnvironmentDescriptorPromise) {
    return primaryEnvironmentDescriptorPromise;
  }

  const nextPromise = fetchPrimaryEnvironmentDescriptor();
  primaryEnvironmentDescriptorPromise = nextPromise;
  return nextPromise.finally(() => {
    if (primaryEnvironmentDescriptorPromise === nextPromise) {
      primaryEnvironmentDescriptorPromise = null;
    }
  });
}

export function resetPrimaryEnvironmentDescriptorForTests(): void {
  primaryEnvironmentDescriptorPromise = null;
  primaryEnvironmentDescriptor = null;
}
