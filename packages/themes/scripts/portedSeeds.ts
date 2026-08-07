import type { ThemeAppearance } from "../src/index.ts";

export type PortedThemeSeed = Readonly<{ background: string; accent: string; action: string; terminal: Readonly<{ background: string; foreground: string; cursor: string; selection: string }> }> & { appearance: ThemeAppearance };
export const PORTED_THEME_SEEDS: Readonly<Record<string, Readonly<{ label: string; light: PortedThemeSeed; dark: PortedThemeSeed }>>> = 
{
  catppuccin: {
    label: "Catppuccin",
    light: {
      appearance: "light",
      background: "#eff1f5",
      accent: "#8839ef",
      action: "#40a02b",
      terminal: {
        background: "#eff1f5",
        foreground: "#4c4f69",
        cursor: "#8839ef",
        selection: "#ccd0da"
      }
    },
    dark: {
      appearance: "dark",
      background: "#1e1e2e",
      accent: "#fab387",
      action: "#74c7ec",
      terminal: {
        background: "#1e1e2e",
        foreground: "#cdd6f4",
        cursor: "#fab387",
        selection: "#313244"
      }
    }
  },
  "tokyo-night": {
    label: "Tokyo Night",
    light: {
      appearance: "light",
      background: "#e1e2e7",
      accent: "#118c74",
      action: "#dababe",
      terminal: {
        background: "#e1e2e7",
        foreground: "#3760bf",
        cursor: "#118c74",
        selection: "#b7c1e3"
      }
    },
    dark: {
      appearance: "dark",
      background: "#16161e",
      accent: "#bb9af7",
      action: "#9ece6a",
      terminal: {
        background: "#1a1b26",
        foreground: "#a9b1d6",
        cursor: "#bb9af7",
        selection: "#2a2f41"
      }
    }
  },
  dracula: {
    label: "Dracula",
    light: {
      appearance: "light",
      background: "#f8f8f2",
      accent: "#644ac9",
      action: "#a3144d",
      terminal: {
        background: "#f8f8f2",
        foreground: "#282a36",
        cursor: "#644ac9",
        selection: "#e8e1d2"
      }
    },
    dark: {
      appearance: "dark",
      background: "#1e1f29",
      accent: "#bd93f9",
      action: "#f1fa8c",
      terminal: {
        background: "#1e1f29",
        foreground: "#f8f8f2",
        cursor: "#bd93f9",
        selection: "#44475a"
      }
    }
  },
  nord: {
    label: "Nord",
    light: {
      appearance: "light",
      background: "#eceff4",
      accent: "#5e81ac",
      action: "#b48ead",
      terminal: {
        background: "#eceff4",
        foreground: "#2e3440",
        cursor: "#5e81ac",
        selection: "#d8dee9"
      }
    },
    dark: {
      appearance: "dark",
      background: "#2e3440",
      accent: "#88c0d0",
      action: "#d08770",
      terminal: {
        background: "#2e3440",
        foreground: "#d8dee9",
        cursor: "#88c0d0",
        selection: "#3b4252"
      }
    }
  },
  gruvbox: {
    label: "Gruvbox",
    light: {
      appearance: "light",
      background: "#f9f5d7",
      accent: "#689d6a",
      action: "#8f3f71",
      terminal: {
        background: "#f9f5d7",
        foreground: "#3c3836",
        cursor: "#689d6a",
        selection: "#d5c4a1"
      }
    },
    dark: {
      appearance: "dark",
      background: "#1d2021",
      accent: "#fe8019",
      action: "#458588",
      terminal: {
        background: "#1d2021",
        foreground: "#ebdbb2",
        cursor: "#fe8019",
        selection: "#3c3836"
      }
    }
  },
  "one-dark": {
    label: "One Dark",
    light: {
      appearance: "light",
      background: "#fafafa",
      accent: "#0184bc",
      action: "#e45649",
      terminal: {
        background: "#fafafa",
        foreground: "#3e4451",
        cursor: "#0184bc",
        selection: "#e5e5e6"
      }
    },
    dark: {
      appearance: "dark",
      background: "#1e2227",
      accent: "#e5c07b",
      action: "#abb2bf",
      terminal: {
        background: "#1e2227",
        foreground: "#abb2bf",
        cursor: "#e5c07b",
        selection: "#3e4451"
      }
    }
  },
  solarized: {
    label: "Solarized",
    light: {
      appearance: "light",
      background: "#fdf6e3",
      accent: "#2aa198",
      action: "#cb4b16",
      terminal: {
        background: "#002b36",
        foreground: "#839496",
        cursor: "#2aa198",
        selection: "#e3dcc8"
      }
    },
    dark: {
      appearance: "dark",
      background: "#002b36",
      accent: "#268bd2",
      action: "#cb4b16",
      terminal: {
        background: "#002b36",
        foreground: "#839496",
        cursor: "#268bd2",
        selection: "#073642"
      }
    }
  },
  kanagawa: {
    label: "Kanagawa",
    light: {
      appearance: "light",
      background: "#f2ecbc",
      accent: "#4d699b",
      action: "#cc6d00",
      terminal: {
        background: "#f2ecbc",
        foreground: "#545464",
        cursor: "#43436c",
        selection: "#54648080"
      }
    },
    dark: {
      appearance: "dark",
      background: "#1f1f28",
      accent: "#7e9cd8",
      action: "#ffa066",
      terminal: {
        background: "#1f1f28",
        foreground: "#dcd7ba",
        cursor: "#c8c093",
        selection: "#d7ba8080"
      }
    }
  },
  "rose-pine": {
    label: "Rosé Pine",
    light: {
      appearance: "light",
      background: "#faf4ed",
      accent: "#907aa9",
      action: "#d7827e",
      terminal: {
        background: "#faf4ed",
        foreground: "#575279",
        cursor: "#575279",
        selection: "#57527980"
      }
    },
    dark: {
      appearance: "dark",
      background: "#191724",
      accent: "#c4a7e7",
      action: "#d0679d",
      terminal: {
        background: "#191724",
        foreground: "#e0def4",
        cursor: "#c4a7e7",
        selection: "#26233a"
      }
    }
  },
  vesper: {
    label: "Vesper",
    light: {
      appearance: "light",
      background: "#fffdf6",
      accent: "#a5642c",
      action: "#0d8a68",
      terminal: {
        background: "#fffdf6",
        foreground: "#3d2a1e",
        cursor: "#a5642c",
        selection: "#f1dcc4"
      }
    },
    dark: {
      appearance: "dark",
      background: "#101010",
      accent: "#ffc799",
      action: "#99ffe4",
      terminal: {
        background: "#101010",
        foreground: "#d6d6d6",
        cursor: "#ffc799",
        selection: "#3b3028"
      }
    }
  },
  terminal: {
    label: "Terminal",
    light: {
      appearance: "light",
      background: "#f6f0e4",
      accent: "#d19a66",
      action: "#4271ae",
      terminal: {
        background: "#f6f0e4",
        foreground: "#4d4d4c",
        cursor: "#d19a66",
        selection: "#efe6d5"
      }
    },
    dark: {
      appearance: "dark",
      background: "#050505",
      accent: "#00ff00",
      action: "#ff0000",
      terminal: {
        background: "#050505",
        foreground: "#cccccc",
        cursor: "#00ff00",
        selection: "#111111"
      }
    }
  },
  github: {
    label: "GitHub",
    light: {
      appearance: "light",
      background: "#f6f8fa",
      accent: "#0969da",
      action: "#9a6700",
      terminal: {
        background: "#f6f8fa",
        foreground: "#1f2328",
        cursor: "#0969da",
        selection: "#e8eaed"
      }
    },
    dark: {
      appearance: "dark",
      background: "#010409",
      accent: "#58a6ff",
      action: "#ffa657",
      terminal: {
        background: "#0d1117",
        foreground: "#c9d1d9",
        cursor: "#58a6ff",
        selection: "#1c2128"
      }
    }
  },
  monokai: {
    label: "Monokai",
    light: {
      appearance: "light",
      background: "#fafafa",
      accent: "#9d1f66",
      action: "#679c00",
      terminal: {
        background: "#fafafa",
        foreground: "#272822",
        cursor: "#9d1f66",
        selection: "#e6e6d8"
      }
    },
    dark: {
      appearance: "dark",
      background: "#1a1b17",
      accent: "#fd971f",
      action: "#66d9ef",
      terminal: {
        background: "#1a1b17",
        foreground: "#f8f8f2",
        cursor: "#fd971f",
        selection: "#49483e"
      }
    }
  },
  poimandres: {
    label: "Poimandres",
    light: {
      appearance: "light",
      background: "#e4f0fb",
      accent: "#00ced1",
      action: "#d0679d",
      terminal: {
        background: "#e4f0fb",
        foreground: "#a6accd",
        cursor: "#00ced1",
        selection: "#717cb425"
      }
    },
    dark: {
      appearance: "dark",
      background: "#1b1e28",
      accent: "#00ced1",
      action: "#d0679d",
      terminal: {
        background: "#1b1e28",
        foreground: "#a6accd",
        cursor: "#00ced1",
        selection: "#717cb425"
      }
    }
  },
  synthwave: {
    label: "Synthwave",
    light: {
      appearance: "light",
      background: "#fef6ff",
      accent: "#ff71ce",
      action: "#05ffa1",
      terminal: {
        background: "#fef6ff",
        foreground: "#8b7a9e",
        cursor: "#ff71ce",
        selection: "#ffe6f7"
      }
    },
    dark: {
      appearance: "dark",
      background: "#0c0c0c",
      accent: "#ff2975",
      action: "#00ffff",
      terminal: {
        background: "#0c0c0c",
        foreground: "#c0c0c8",
        cursor: "#ff2975",
        selection: "#2a1342"
      }
    }
  },
  monochrome: {
    label: "Monochrome",
    light: {
      appearance: "light",
      background: "#fafafa",
      accent: "#3b82f6",
      action: "#6b6b6b",
      terminal: {
        background: "#fafafa",
        foreground: "#2d2d2d",
        cursor: "#3b82f6",
        selection: "#e8e8e8"
      }
    },
    dark: {
      appearance: "dark",
      background: "#0d0d0d",
      accent: "#5fafaf",
      action: "#8a8a8a",
      terminal: {
        background: "#0d0d0d",
        foreground: "#e0e0e0",
        cursor: "#5fafaf",
        selection: "#3a3a3a"
      }
    }
  },
  lavender: {
    label: "Lavender",
    light: {
      appearance: "light",
      background: "#f3e5f5",
      accent: "#7e57c2",
      action: "#fdd835",
      terminal: {
        background: "#f3e5f5",
        foreground: "#4527a0",
        cursor: "#7e57c2",
        selection: "#ede7f6"
      }
    },
    dark: {
      appearance: "dark",
      background: "#1e1f29",
      accent: "#bd93f9",
      action: "#f1fa8c",
      terminal: {
        background: "#1e1f29",
        foreground: "#f8f8f2",
        cursor: "#bd93f9",
        selection: "#282a36"
      }
    }
  },
  sunset: {
    label: "Sunset",
    light: {
      appearance: "light",
      background: "#fffcf5",
      accent: "#d4a259",
      action: "#8b6fa3",
      terminal: {
        background: "#fffcf5",
        foreground: "#d4a259",
        cursor: "#d4a259",
        selection: "#ffdec9"
      }
    },
    dark: {
      appearance: "dark",
      background: "#120d18",
      accent: "#ff9e4a",
      action: "#214675",
      terminal: {
        background: "#120d18",
        foreground: "#ffc345",
        cursor: "#ff9e4a",
        selection: "#2d2436"
      }
    }
  },
  aurora: {
    label: "Aurora",
    light: {
      appearance: "light",
      background: "#fbfcfd",
      accent: "#8bcbb8",
      action: "#e3a7b4",
      terminal: {
        background: "#fbfcfd",
        foreground: "#2f3b3a",
        cursor: "#8bcbb8",
        selection: "#eef6f5"
      }
    },
    dark: {
      appearance: "dark",
      background: "#0f0f1a",
      accent: "#bd00ff",
      action: "#ffee00",
      terminal: {
        background: "#0f0f1a",
        foreground: "#a0a0a0",
        cursor: "#bd00ff",
        selection: "#1a1a2e"
      }
    }
  },
  retro: {
    label: "Retro",
    light: {
      appearance: "light",
      background: "#f4f1e8",
      accent: "#ffbb00",
      action: "#3366cc",
      terminal: {
        background: "#f4f1e8",
        foreground: "#2b2b2b",
        cursor: "#ffbb00",
        selection: "#e8e4d8"
      }
    },
    dark: {
      appearance: "dark",
      background: "#0a0a0a",
      accent: "#ffc633",
      action: "#66b3ff",
      terminal: {
        background: "#0a0a0a",
        foreground: "#ffc633",
        cursor: "#ffc633",
        selection: "#1f1a10"
      }
    }
  },
  termius: {
    label: "Termius",
    light: {
      appearance: "light",
      background: "#edf1f2",
      accent: "#198c51",
      action: "#186cb5",
      terminal: {
        background: "#d5dde0",
        foreground: "#32364a",
        cursor: "#32364a",
        selection: "#32364a80"
      }
    },
    dark: {
      appearance: "dark",
      background: "#141729",
      accent: "#21b568",
      action: "#2091f6",
      terminal: {
        background: "#141729",
        foreground: "#21b568",
        cursor: "#21b568",
        selection: "#21b56880"
      }
    }
  },
  manhattan: {
    label: "Manhattan",
    light: {
      appearance: "light",
      background: "#f4f4f0",
      accent: "#4f4f4c",
      action: "#8a6d1a",
      terminal: {
        background: "#f4f4f0",
        foreground: "#2e2e2b",
        cursor: "#4f4f4c",
        selection: "#deded680"
      }
    },
    dark: {
      appearance: "dark",
      background: "#0a0a0a",
      accent: "#d1d1cb",
      action: "#d8b741",
      terminal: {
        background: "#0a0a0a",
        foreground: "#b8b9b4",
        cursor: "#dfe0db",
        selection: "#b8b9b480"
      }
    }
  },
  cyberpunk: {
    label: "Cyberpunk",
    light: {
      appearance: "light",
      background: "#f5f5f7",
      accent: "#ea00d9",
      action: "#00ff9f",
      terminal: {
        background: "#f5f5f7",
        foreground: "#6b6b70",
        cursor: "#ea00d9",
        selection: "#f0e8ff"
      }
    },
    dark: {
      appearance: "dark",
      background: "#091833",
      accent: "#ff007a",
      action: "#00ffb3",
      terminal: {
        background: "#091833",
        foreground: "#00ffb3",
        cursor: "#ff007a",
        selection: "#1b1b2a"
      }
    }
  },
  winter: {
    label: "Winter",
    light: {
      appearance: "light",
      background: "#ece3d1",
      accent: "#546f88",
      action: "#9c3b12",
      terminal: {
        background: "#ece3d1",
        foreground: "#1a2720",
        cursor: "#5c6370",
        selection: "#abb2bf80"
      }
    },
    dark: {
      appearance: "dark",
      background: "#00192c",
      accent: "#f8cfa6",
      action: "#94d2b5",
      terminal: {
        background: "#00192c",
        foreground: "#e4d5cc",
        cursor: "#f8cfa6",
        selection: "#e4d5cc80"
      }
    }
  }
}
;
