/** @type {import("next").NextConfig} */
const nextConfig = {
  // next.config routing surface, asserted by the smoke tests.
  async redirects() {
    return [{ source: "/old-home", destination: "/", permanent: true }];
  },
  async rewrites() {
    return [{ source: "/rewritten-hello", destination: "/api/hello" }];
  },
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [
          { key: "x-fixture-config-header", value: "from-next-config" },
        ],
      },
    ];
  },
};

export default nextConfig;
