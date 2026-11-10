import { uneval } from "devalue";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ platform }) => {
  return {
    secret: platform?.env?.FIXTURE_SECRET ?? "no-platform-env",
    hasCtx: typeof platform?.ctx?.waitUntil === "function",
    // exercise `devalue` (conditional-exports dep used by kit itself)
    devalued: uneval({ n: 1 }),
  };
};
