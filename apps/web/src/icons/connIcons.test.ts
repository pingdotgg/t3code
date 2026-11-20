import { describe, expect, it } from "vite-plus/test";

import tsconfig from "../../tsconfig.json?raw";
import viteConfig from "../../vite.config.ts?raw";
import workspaceVisuals from "../components/sidebar/workspaceVisuals.tsx?raw";

// Conn fork guard: an upstream merge must not silently drop the wiring that
// sends Lucide imports to Conn's generated icon module. See FORK.md, "Icons".
describe("Conn icon module", () => {
  it("maps lucide-react to src/icons in Vite and TypeScript", () => {
    expect(viteConfig).toContain("find: /^lucide-react$/");
    expect(viteConfig).toContain('"./src/icons/lucide-react.ts"');
    expect(tsconfig).toContain('"lucide-react": ["./src/icons/lucide-react.ts"]');
  });

  it("keeps workspace icons on the original Lucide package", () => {
    expect(workspaceVisuals).toContain('from "lucide-react-original"');
  });
});
