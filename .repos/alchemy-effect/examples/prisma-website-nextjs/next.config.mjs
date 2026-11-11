/** @type {import("next").NextConfig} */
const nextConfig = {
  typescript: {
    // Type-check only the Next app code. The default tsconfig.json also
    // includes alchemy.run.ts and test/, which import the `alchemy` workspace
    // package — its types resolve from packages/alchemy's built lib/, which a
    // source-only checkout doesn't have. Those files are covered by the
    // repo-wide `tsc -b` instead.
    tsconfigPath: "tsconfig.next.json",
  },
};

export default nextConfig;
