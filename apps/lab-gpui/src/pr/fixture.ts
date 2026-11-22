import type { PullRequestDetailView } from "@t3tools/contracts";
import detail from "./pr-38991.json";
import patch from "./pr-38991.patch?raw";

/** pingdotgg/t3code#38991, fetched with gh on 2026-11-19, in Conn's PR detail shape. Every PR
    the lab opens shows this body, under the number and repository it was opened with. */
export const LAB_PULL_REQUEST = detail as unknown as PullRequestDetailView;
export const LAB_DIFF: string = patch;
