import { useEffect, useState } from "react";

const CANONICAL_ORIGIN = "https://alchemy.run";

/**
 * Build the copy-for-agent prompt. The doc links must be absolute — the
 * prompt is pasted into a coding agent outside the browser — so instead of
 * relative paths, the origin is a parameter: preview deployments pass their
 * own origin and produce prompts that point back at themselves.
 */
export const agentPrompt = (
  origin: string = CANONICAL_ORIGIN,
) => `Help me build an Alchemy app on Cloudflare. Start by reading ${origin}/getting-started and follow it exactly: scaffold a fresh project, install the dependencies, create the \`alchemy.run.ts\` Stack with a single Cloudflare R2 Bucket (no Worker yet), and run \`alchemy deploy\` so I sign in to Cloudflare and provision the Bucket. Confirm the Bucket is live before moving on.

Then STOP and ASK ME what I want to build. From there, consult only the docs you need for what I asked for — don't march me through every tutorial. A Worker only gets added later if what I want to build needs one (the tutorial covers that in part-2).

Tutorial — foundations, work through whichever parts I haven't touched:
  ${origin}/cloudflare/tutorial/part-1  First Stack (state store + first resource)
  ${origin}/cloudflare/tutorial/part-2  Add a Worker
  ${origin}/cloudflare/tutorial/part-3  Testing
  ${origin}/cloudflare/tutorial/part-4  Local Dev (\`alchemy dev\`)
  ${origin}/cloudflare/tutorial/part-5  CI/CD (per-PR previews from GitHub Actions)

For everything else (Cloudflare deep-dives, guides, concepts), fetch ${origin}/llms.txt — it's the index of the guide and concept docs. Use it to look up the specific page you need instead of guessing URLs. The per-resource API reference is indexed separately in ${origin}/llms-full.txt — it's large, so only fetch it when you need a specific resource's reference page.

Important:
- Confirm with me before each deploy. Don't batch.
- Do NOT instruct me to export CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN. Alchemy stores credentials in profiles — \`alchemy login\` (or the first \`alchemy deploy\`) prompts interactively for OAuth or an API token and saves it to ~/.alchemy/profiles.json.
- Use \`bun alchemy deploy\` (or the npm/pnpm/yarn equivalent).
- If I'm migrating from Alchemy v1 (async/await), find the v1 migration guide via llms.txt and read it first.`;

/**
 * The agent prompt for the current deployment. SSR and first paint render
 * the canonical-origin prompt; after hydration it swaps to the page's own
 * origin (a no-op string-wise on prod, the preview URL on PR previews).
 */
export const useAgentPrompt = () => {
  const [prompt, setPrompt] = useState(agentPrompt());
  useEffect(() => setPrompt(agentPrompt(window.location.origin)), []);
  return prompt;
};
