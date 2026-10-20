import { defineConfig } from "vite-plus";
import "vite-plus/test/config";

const reactTests = [
  "src/components/ui/Dialog.android.test.tsx",
  "src/features/home/home-route-visibility.test.tsx",
  "src/features/settings/SettingsServerControlsRouteScreen.test.tsx",
  "src/features/settings/components/BranchNamingSettings.test.tsx",
  "src/features/threads/use-visible-second-clock.test.tsx",
  "src/features/threads/useThreadHeaderOptions.test.tsx",
  "src/native/NativeHeaderToolbar.test.tsx",
  "src/state/use-selected-thread-git-actions.test.tsx",
];

export default defineConfig({
  test: {
    hookTimeout: 60_000,
    testTimeout: 60_000,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["**/*.test.{ts,tsx,mjs}"],
          exclude: ["**/node_modules/**", ...reactTests],
          setupFiles: ["../../packages/shared/src/testing/longTempDir.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "react",
          include: reactTests,
          // Native components mock React Native and render through react-dom in these tests.
          environment: "jsdom",
        },
      },
    ],
  },
});
