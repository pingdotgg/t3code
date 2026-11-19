import { describe, expect, it } from "vite-plus/test";

import { normalizeEntertainmentUrl, shouldOpenExternally, youtubeEmbedUrl } from "./entertainment.ts";

describe("entertainment URLs", () => {
  it("turns YouTube links into the official privacy-enhanced embed", () => {
    expect(youtubeEmbedUrl("https://www.youtube.com/watch?v=aqz-KE-bpKQ&t=30s")).toBe(
      "https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ?autoplay=1&rel=0&start=30",
    );
    expect(youtubeEmbedUrl("https://youtu.be/aqz-KE-bpKQ")).toContain("/embed/aqz-KE-bpKQ?");
    expect(youtubeEmbedUrl("https://www.youtube.com/shorts/aqz-KE-bpKQ")).toContain("/embed/aqz-KE-bpKQ?");
    expect(youtubeEmbedUrl("https://example.com/watch?v=aqz-KE-bpKQ")).toBeNull();
    expect(youtubeEmbedUrl("https://www.youtube.com/watch?v=<script>")).toBeNull();
  });

  it("sends DRM and blocked sign-in pages to the default browser", () => {
    expect(shouldOpenExternally("https://accounts.google.com/signin")).toBe(true);
    expect(shouldOpenExternally("https://www.netflix.com/browse")).toBe(true);
    expect(shouldOpenExternally("file:///etc/passwd")).toBe(true);
    expect(shouldOpenExternally("https://www.youtube.com/")).toBe(false);
  });

  it("accepts only http(s) sites the user adds", () => {
    expect(normalizeEntertainmentUrl("nebula.tv")).toBe("https://nebula.tv/");
    expect(normalizeEntertainmentUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeEntertainmentUrl("localhost")).toBeNull();
  });
});
