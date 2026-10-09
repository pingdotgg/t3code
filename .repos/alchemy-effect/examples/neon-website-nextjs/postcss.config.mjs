// Tailwind CSS v4 wired the canonical Next.js way: Next.js runs its own
// PostCSS pipeline during `next build`, so this file being honored proves
// Alchemy delegates to the project's real Next.js build.
export default { plugins: { "@tailwindcss/postcss": {} } };
