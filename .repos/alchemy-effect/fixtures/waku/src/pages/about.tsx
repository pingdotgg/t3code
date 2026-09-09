export default function AboutPage() {
  return (
    <div>
      <div data-testid="about-marker">ABOUT_STATIC_MARKER</div>
    </div>
  );
}

// Static: rendered at build time by the SSG step (requires the
// __WAKU_START_PREVIEW_SERVER__ global + the rsc env's `build` input).
export const getConfig = async () => ({ render: "static" }) as const;
