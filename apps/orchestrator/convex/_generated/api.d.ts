/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as http from "../http.js";
import type * as linear from "../linear.js";
import type * as projects from "../projects.js";
import type * as t3Runtime from "../t3Runtime.js";
import type * as taskEvents from "../taskEvents.js";
import type * as taskExternalLinks from "../taskExternalLinks.js";
import type * as taskIntake from "../taskIntake.js";
import type * as taskThreads from "../taskThreads.js";
import type * as tasks from "../tasks.js";
import type * as workSessions from "../workSessions.js";

import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";

declare const fullApi: ApiFromModules<{
  http: typeof http;
  linear: typeof linear;
  projects: typeof projects;
  t3Runtime: typeof t3Runtime;
  taskEvents: typeof taskEvents;
  taskExternalLinks: typeof taskExternalLinks;
  taskIntake: typeof taskIntake;
  taskThreads: typeof taskThreads;
  tasks: typeof tasks;
  workSessions: typeof workSessions;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<typeof fullApi, FunctionReference<any, "public">>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<typeof fullApi, FunctionReference<any, "internal">>;

export declare const components: {
  agent: import("@convex-dev/agent/_generated/component.js").ComponentApi<"agent">;
};
