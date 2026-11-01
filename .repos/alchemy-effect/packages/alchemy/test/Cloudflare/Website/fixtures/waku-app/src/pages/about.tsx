/** @jsxImportSource react */
export default function AboutPage() {
  return (
    <div>
      <div data-testid="about-marker">WAKU_ABOUT_STATIC_MARKER</div>
    </div>
  );
}

// Static: rendered at build time by waku's SSG step and served from assets.
export const getConfig = async () => ({ render: "static" }) as const;
