import * as NodeModule from "node:module";

import { describe, expect, it } from "vite-plus/test";

type StoryboardColor = {
  $: Record<string, string>;
};

type StoryboardModResults = {
  document: {
    scenes: Array<{
      scene: Array<{
        objects: Array<{
          viewController: Array<{
            view: Array<{
              color: Array<StoryboardColor>;
            }>;
          }>;
        }>;
      }>;
    }>;
    resources: Array<{
      namedColor: Array<{
        $: { name: string };
        color: Array<StoryboardColor>;
      }>;
    }>;
  };
};

const require = NodeModule.createRequire(import.meta.url);
const { inlineSplashScreenBackground } = require("./withIosSplashScreenInlineBackground.cjs") as {
  inlineSplashScreenBackground: (modResults: StoryboardModResults) => StoryboardModResults;
};

describe("iOS splash screen inline background", () => {
  it("transforms Expo's real storyboard modResults shape", () => {
    const modResults: StoryboardModResults = {
      document: {
        scenes: [
          {
            scene: [
              {
                objects: [
                  {
                    viewController: [
                      {
                        view: [
                          {
                            color: [
                              {
                                $: {
                                  key: "backgroundColor",
                                  name: "SplashScreenBackground",
                                },
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
        resources: [
          {
            namedColor: [
              {
                $: { name: "SplashScreenBackground" },
                color: [
                  {
                    $: {
                      alpha: "1.000",
                      blue: "0.450980392156863",
                      green: "0.450980392156863",
                      red: "0.450980392156863",
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    };

    expect(inlineSplashScreenBackground(modResults)).toBe(modResults);
    expect(
      modResults.document.scenes[0]?.scene[0]?.objects[0]?.viewController[0]?.view[0]?.color,
    ).toEqual([
      {
        $: {
          key: "backgroundColor",
          alpha: "1.000",
          blue: "0.450980392156863",
          green: "0.450980392156863",
          red: "0.450980392156863",
        },
      },
    ]);
  });
});
