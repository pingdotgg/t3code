export default function AboutPage() {
  return (
    <div>
      <h1>About</h1>
      <p>
        This page is prerendered at build time (SSG) and served as a static
        asset.
      </p>
    </div>
  );
}

// Static: rendered at build time by waku's SSG step and served from assets.
export const getConfig = async () => ({ render: "static" }) as const;
