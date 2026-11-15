/**
 * Local Flagship simulator.
 *
 * A single `flagship` service hosts every app. Its `Flagship` entrypoint is
 * what a worker's `flagship` binding targets: it mirrors the runtime
 * `Flagship` binding (`get`, `getBooleanValue`, `getStringDetails`, ...),
 * reading the flag's definition file through the `flagship:storage` disk
 * service and evaluating it locally (see `FlagshipEvaluate.shared.ts`).
 *
 * Definitions are written by deploy-time tooling (alchemy's local Flag
 * provider) straight to disk; the file is read fresh on every evaluation, so
 * flag changes apply to running workers without a restart. The app id
 * travels on the service designator props (`ctx.props.appId`).
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  evaluateFlag,
  type FlagshipDetails,
  type FlagshipValueType,
} from "./FlagshipEvaluate.shared.ts";
import {
  BINDING_FLAGSHIP_DISK,
  flagFileSegments,
  type FlagshipFlagDefinition,
  type FlagshipServiceProps,
} from "./FlagshipOptions.shared.ts";

interface Env {
  [BINDING_FLAGSHIP_DISK]: Fetcher;
}

export class Flagship extends WorkerEntrypoint<Env, FlagshipServiceProps> {
  async get(flagKey: string, defaultValue?: unknown, context?: unknown): Promise<unknown> {
    return (await this.#evaluate(flagKey, defaultValue, undefined, context)).value;
  }
  async getBooleanValue(flagKey: string, defaultValue: boolean, context?: unknown) {
    return (await this.#evaluate(flagKey, defaultValue, "boolean", context)).value;
  }
  async getStringValue(flagKey: string, defaultValue: string, context?: unknown) {
    return (await this.#evaluate(flagKey, defaultValue, "string", context)).value;
  }
  async getNumberValue(flagKey: string, defaultValue: number, context?: unknown) {
    return (await this.#evaluate(flagKey, defaultValue, "number", context)).value;
  }
  async getObjectValue(flagKey: string, defaultValue: object, context?: unknown) {
    return (await this.#evaluate(flagKey, defaultValue, "object", context)).value;
  }
  getBooleanDetails(flagKey: string, defaultValue: boolean, context?: unknown) {
    return this.#evaluate(flagKey, defaultValue, "boolean", context);
  }
  getStringDetails(flagKey: string, defaultValue: string, context?: unknown) {
    return this.#evaluate(flagKey, defaultValue, "string", context);
  }
  getNumberDetails(flagKey: string, defaultValue: number, context?: unknown) {
    return this.#evaluate(flagKey, defaultValue, "number", context);
  }
  getObjectDetails(flagKey: string, defaultValue: object, context?: unknown) {
    return this.#evaluate(flagKey, defaultValue, "object", context);
  }

  async #evaluate(
    flagKey: string,
    defaultValue: unknown,
    expectedType: FlagshipValueType | undefined,
    context: unknown,
  ): Promise<FlagshipDetails> {
    const [app, file] = flagFileSegments(this.ctx.props.appId, flagKey);
    const response = await this.env[BINDING_FLAGSHIP_DISK].fetch(
      `http://placeholder/${app}/${file}`,
    );
    let flag: FlagshipFlagDefinition | undefined;
    if (response.status === 404) {
      await response.body?.cancel();
    } else if (!response.ok) {
      return {
        flagKey,
        value: defaultValue,
        reason: "ERROR",
        errorCode: "GENERAL",
        errorMessage: `Flagship storage request failed: ${response.status} ${await response.text()}`,
      };
    } else {
      const text = await response.text();
      try {
        flag = JSON.parse(text) as FlagshipFlagDefinition;
      } catch {
        return {
          flagKey,
          value: defaultValue,
          reason: "ERROR",
          errorCode: "PARSE_ERROR",
          errorMessage: `Flag "${flagKey}" has an invalid definition`,
        };
      }
    }
    return evaluateFlag({ flagKey, flag, defaultValue, expectedType, context });
  }
}

export default {
  fetch() {
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
