export const AGENT_PROMPT = `Help me build an Alchemy app on Cloudflare. Start by reading https://v2.alchemy.run/getting-started and follow it exactly: scaffold a fresh project, install the dependencies, create the \`alchemy.run.ts\` Stack with a single Cloudflare R2 Bucket (no Worker yet), and run \`alchemy deploy\` so I sign in to Cloudflare and provision the Bucket. Confirm the Bucket is live before moving on.

Then STOP and ASK ME what I want to build. From there, consult only the docs you need for what I asked for — don't march me through every tutorial. A Worker only gets added later if what I want to build needs one (the tutorial covers that in part-2).

Tutorial — foundations, work through whichever parts I haven't touched:
  https://v2.alchemy.run/tutorial/part-1  First Stack (state store + first resource)
  https://v2.alchemy.run/tutorial/part-2  Add a Worker
  https://v2.alchemy.run/tutorial/part-3  Testing
  https://v2.alchemy.run/tutorial/part-4  Local Dev (\`alchemy dev\`)
  https://v2.alchemy.run/tutorial/part-5  CI/CD (per-PR previews from GitHub Actions)

For everything else (Cloudflare deep-dives, guides, concepts, API reference), fetch https://v2.alchemy.run/llms.txt — it's the index of every doc on the site. Use it to look up the specific page you need instead of guessing URLs.

Important:
- Confirm with me before each deploy. Don't batch.
- Do NOT instruct me to export CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN. Alchemy stores credentials in profiles — \`alchemy login\` (or the first \`alchemy deploy\`) prompts interactively for OAuth or an API token and saves it to ~/.alchemy/profiles.json.
- Use \`bun alchemy deploy\` (or the npm/pnpm/yarn equivalent).
- If I'm migrating from Alchemy v1 (async/await), find the v1 migration guide via llms.txt and read it first.`;
