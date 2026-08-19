export const BUILT_IN_THEME_IDS = ["t3-chat", "grove", "ocean", "ember", "iris"] as const;

/** The mobile app's own hand-tuned palette, which is not part of the built-in library. */
export const MOBILE_DEFAULT_THEME_ID = "t3-code";

/**
 * Every palette the mobile app can render. Declared here so host-side tooling
 * (the app-store screenshot harness) can validate a requested theme without
 * importing React Native application code.
 */
export const MOBILE_THEME_IDS = [MOBILE_DEFAULT_THEME_ID, ...BUILT_IN_THEME_IDS] as const;

export type BuiltInThemeId = (typeof BUILT_IN_THEME_IDS)[number];
export type MobileThemeId = (typeof MOBILE_THEME_IDS)[number];
export type ThemeAppearance = "light" | "dark";

/** Product roles shared by web CSS, React Native tokens, and native surfaces. */
export const THEME_COLOR_ROLES = [
  "canvas",
  "surface",
  "surfaceRaised",
  "surfaceOverlay",
  "text",
  "mutedForeground",
  "border",
  "input",
  "secondary",
  "accentSurface",
  "accent",
  "messageAction",
  "messageSurface",
  "codeBackground",
  "sidebar",
  "sidebarControlSurface",
  "sidebarRowSelected",
  "terminalBackground",
  "error",
  "warning",
] as const;

export type ThemeColorRole = (typeof THEME_COLOR_ROLES)[number];
export type ThemeColors = Readonly<Record<ThemeColorRole, string>>;
export type ThemeVariants = Readonly<Partial<Record<ThemeAppearance, ThemeColors>>>;
export type ThemeDefinition = Readonly<{
  id: string;
  label: string;
  appearance: ThemeAppearance;
  colors: ThemeColors;
  variants?: ThemeVariants;
  /** Groups related imported variants into one library card. */
  collection?: Readonly<{ id: string; label: string }>;
  /** Allows reviewed built-ins to render product artwork over their sidebar. */
  sidebarArtwork?: boolean;
  /** Generated from the guided editor's canvas and accent roles. */
  managed?: boolean;
}>;

export const T3_CHAT_THEME: ThemeDefinition = {
  id: "t3-chat",
  label: "T3 Chat",
  appearance: "light",
  colors: {
    canvas: "oklch(0.982446 0.010114 325.653)",
    surface: "oklch(0.971835 0.012884 321.894)",
    surfaceRaised: "oklch(0.988235 0.005049 325.615)",
    surfaceOverlay: "oklch(1 0 0)",
    text: "oklch(0.325698 0.116116 325.037)",
    border: "oklch(0.923531 0.021247 328.096)",
    input: "oklch(0.851713 0.055822 336.6)",
    accent: "oklch(0.591646 0.217985 0.584)",
    secondary: "oklch(0.869588 0.06751 334.899)",
    mutedForeground: "oklch(0.428932 0.163929 354.332)",
    error: "oklch(0.627117 0.248974 7.734)",
    warning: "oklch(0.76859 0.164659 70.08)",
    accentSurface: "oklch(0.939552 0.024286 321.664)",
    messageSurface: "oklch(0.926746 0.037898 332.6)",
    messageAction: "oklch(0.591646 0.217985 0.584)",
    codeBackground: "oklch(0.953855 0.019695 315.668)",
    sidebar: "oklch(0.928886 0.031178 322.592)",
    sidebarControlSurface: "oklch(0.978851 0.001321 106.424)",
    sidebarRowSelected: "oklch(0.978851 0.001321 106.424)",
    terminalBackground: "oklch(0.982446 0.010114 325.653)",
  },
  variants: {
    dark: {
      canvas: "oklch(0.22813 0.020366 307.469)",
      surface: "oklch(0.267101 0.02016 311.799)",
      surfaceRaised: "oklch(0.279864 0.021572 309.532)",
      surfaceOverlay: "oklch(0.154761 0.01316 338.901)",
      text: "oklch(0.980735 0.004092 301.426)",
      border: "oklch(0.266943 0.015262 302.425)",
      input: "oklch(0.266817 0.02897 344.461)",
      accent: "oklch(0.460685 0.185347 4.099)",
      secondary: "oklch(0.313674 0.030572 310.061)",
      mutedForeground: "oklch(0.880303 0.03077 342.696)",
      error: "oklch(0.458704 0.169677 3.815)",
      warning: "oklch(0.76859 0.164659 70.08)",
      accentSurface: "oklch(0.364912 0.050794 308.491)",
      messageSurface: "oklch(0.273791 0.025541 309.079)",
      messageAction: "oklch(0.460685 0.185347 4.099)",
      codeBackground: "oklch(0.22813 0.020366 307.469)",
      sidebar: "oklch(0.185778 0.019368 322.159)",
      sidebarControlSurface: "oklch(0.23366 0.026081 338.196)",
      sidebarRowSelected: "oklch(0.23366 0.026081 338.196)",
      terminalBackground: "oklch(0.22813 0.020366 307.469)",
    },
  },
  sidebarArtwork: true,
};

export const GROVE_THEME: ThemeDefinition = {
  id: "grove",
  label: "Grove",
  appearance: "light",
  colors: {
    canvas: "oklch(0.972369 0.005497 157.15)",
    surface: "oklch(0.972369 0.005497 157.15)",
    surfaceRaised: "oklch(0.949276 0.004496 159.002)",
    surfaceOverlay: "oklch(0.932695 0.003778 160.944)",
    text: "oklch(0.222003 0.03479 328.979)",
    border: "oklch(0.864831 0.01312 167.255)",
    input: "oklch(0.829746 0.016084 168.234)",
    accent: "oklch(0.523295 0.112292 158.089)",
    secondary: "oklch(0.936464 0.014601 163.554)",
    mutedForeground: "oklch(0.527266 0.012309 320.683)",
    error: "oklch(0.637823 0.237287 25.436)",
    warning: "oklch(0.772406 0.172798 65.367)",
    accentSurface: "oklch(0.909438 0.021521 164.612)",
    messageSurface: "oklch(0.891377 0.026164 164.929)",
    messageAction: "oklch(0.535028 0.106403 77.549)",
    codeBackground: "oklch(0.955888 0.004783 158.391)",
    sidebar: "oklch(0.936464 0.014601 163.554)",
    sidebarControlSurface: "oklch(0.88585 0.011734 166.331)",
    sidebarRowSelected: "oklch(0.836654 0.040284 165.149)",
    terminalBackground: "oklch(0.972369 0.005497 157.15)",
  },
  variants: {
    dark: {
      canvas: "oklch(0.260865 0.02152 162.75)",
      surface: "oklch(0.260865 0.02152 162.75)",
      surfaceRaised: "oklch(0.363192 0.016572 165.32)",
      surfaceOverlay: "oklch(0.411828 0.014378 166.627)",
      text: "oklch(0.990339 0.008411 325.64)",
      border: "oklch(0.457475 0.044046 160.971)",
      input: "oklch(0.519849 0.049896 160.863)",
      accent: "oklch(0.796228 0.133058 157.319)",
      secondary: "oklch(0.380487 0.048313 159.608)",
      mutedForeground: "oklch(0.715427 0.010896 171.428)",
      error: "oklch(0.655108 0.221148 23.473)",
      warning: "oklch(0.772406 0.172798 65.367)",
      accentSurface: "oklch(0.437021 0.060312 158.962)",
      messageSurface: "oklch(0.470111 0.067221 158.676)",
      messageAction: "oklch(0.791603 0.129713 83.299)",
      codeBackground: "oklch(0.312979 0.018942 164.082)",
      sidebar: "oklch(0.309925 0.032827 160.944)",
      sidebarControlSurface: "oklch(0.432727 0.024549 163.654)",
      sidebarRowSelected: "oklch(0.437466 0.060406 158.958)",
      terminalBackground: "oklch(0.260865 0.02152 162.75)",
    },
  },
  sidebarArtwork: true,
};

export const OCEAN_THEME: ThemeDefinition = {
  id: "ocean",
  label: "Ocean",
  appearance: "light",
  colors: {
    canvas: "oklch(0.974199 0.002856 241.597)",
    surface: "oklch(0.974199 0.002856 241.597)",
    surfaceRaised: "oklch(0.951058 0.002962 258.339)",
    surfaceOverlay: "oklch(0.934442 0.003181 269.1)",
    text: "oklch(0.222003 0.03479 328.979)",
    border: "oklch(0.867646 0.013482 252.362)",
    input: "oklch(0.832939 0.017389 252.598)",
    accent: "oklch(0.536684 0.120219 247.01)",
    secondary: "oklch(0.939254 0.01193 241.729)",
    mutedForeground: "oklch(0.528741 0.01828 313.823)",
    error: "oklch(0.637823 0.237287 25.436)",
    warning: "oklch(0.772406 0.172798 65.367)",
    accentSurface: "oklch(0.91295 0.018827 241.836)",
    messageSurface: "oklch(0.895373 0.023469 241.913)",
    messageAction: "oklch(0.493961 0.08175 201.584)",
    codeBackground: "oklch(0.957684 0.002906 253.68)",
    sidebar: "oklch(0.939254 0.01193 241.729)",
    sidebarControlSurface: "oklch(0.888479 0.011475 251.638)",
    sidebarRowSelected: "oklch(0.842113 0.037689 242.174)",
    terminalBackground: "oklch(0.974199 0.002856 241.597)",
  },
  variants: {
    dark: {
      canvas: "oklch(0.242641 0.024125 250.573)",
      surface: "oklch(0.242641 0.024125 250.573)",
      surfaceRaised: "oklch(0.348439 0.019942 253.696)",
      surfaceOverlay: "oklch(0.398517 0.018232 255.72)",
      text: "oklch(0.990339 0.008411 325.64)",
      border: "oklch(0.438653 0.039496 245.44)",
      input: "oklch(0.500905 0.043574 244.781)",
      accent: "oklch(0.758933 0.105833 241.548)",
      secondary: "oklch(0.358725 0.043145 244.911)",
      mutedForeground: "oklch(0.691936 0.016294 261.588)",
      error: "oklch(0.655108 0.221148 23.473)",
      warning: "oklch(0.772406 0.172798 65.367)",
      accentSurface: "oklch(0.413315 0.051874 243.855)",
      messageSurface: "oklch(0.445224 0.056936 243.413)",
      messageAction: "oklch(0.793363 0.105022 199.893)",
      codeBackground: "oklch(0.29661 0.021883 251.968)",
      sidebar: "oklch(0.290387 0.032043 247.274)",
      sidebarControlSurface: "oklch(0.417822 0.02535 250.162)",
      sidebarRowSelected: "oklch(0.413744 0.051943 243.848)",
      terminalBackground: "oklch(0.242641 0.024125 250.573)",
    },
  },
  sidebarArtwork: true,
};

export const EMBER_THEME: ThemeDefinition = {
  id: "ember",
  label: "Ember",
  appearance: "light",
  colors: {
    canvas: "oklch(0.976527 0.002685 60.725)",
    surface: "oklch(0.976527 0.002685 60.725)",
    surfaceRaised: "oklch(0.953321 0.002701 42.266)",
    surfaceOverlay: "oklch(0.936659 0.002879 29.96)",
    text: "oklch(0.222003 0.03479 328.979)",
    border: "oklch(0.870631 0.013204 39.431)",
    input: "oklch(0.836213 0.017153 38.661)",
    accent: "oklch(0.552831 0.129438 44.656)",
    secondary: "oklch(0.942267 0.01151 50.785)",
    mutedForeground: "oklch(0.530413 0.018453 341.181)",
    error: "oklch(0.637823 0.237287 25.436)",
    warning: "oklch(0.772406 0.172798 65.367)",
    accentSurface: "oklch(0.916502 0.01832 49.597)",
    messageSurface: "oklch(0.899296 0.022939 49.163)",
    messageAction: "oklch(0.516323 0.161628 24.82)",
    codeBackground: "oklch(0.959965 0.002668 47.512)",
    sidebar: "oklch(0.942267 0.01151 50.785)",
    sidebarControlSurface: "oklch(0.891332 0.011179 40.596)",
    sidebarRowSelected: "oklch(0.84723 0.037292 48.403)",
    terminalBackground: "oklch(0.976527 0.002685 60.725)",
  },
  variants: {
    dark: {
      canvas: "oklch(0.245899 0.019144 42.044)",
      surface: "oklch(0.245899 0.019144 42.044)",
      surfaceRaised: "oklch(0.351262 0.01565 37.592)",
      surfaceOverlay: "oklch(0.401111 0.014308 34.896)",
      text: "oklch(0.990339 0.008411 325.64)",
      border: "oklch(0.44099 0.040202 48.807)",
      input: "oklch(0.503003 0.045721 49.44)",
      accent: "oklch(0.762174 0.124117 52.082)",
      secondary: "oklch(0.361499 0.044052 49.515)",
      mutedForeground: "oklch(0.692479 0.015227 30.963)",
      error: "oklch(0.655108 0.221148 23.473)",
      warning: "oklch(0.772406 0.172798 65.367)",
      accentSurface: "oklch(0.416048 0.055354 50.484)",
      messageSurface: "oklch(0.447961 0.061874 50.849)",
      messageAction: "oklch(0.747955 0.135578 29.432)",
      codeBackground: "oklch(0.299662 0.017229 39.973)",
      sidebar: "oklch(0.293349 0.029554 46.882)",
      sidebarControlSurface: "oklch(0.420227 0.022893 43.226)",
      sidebarRowSelected: "oklch(0.416477 0.055442 50.489)",
      terminalBackground: "oklch(0.245899 0.019144 42.044)",
    },
  },
  sidebarArtwork: true,
};

export const IRIS_THEME: ThemeDefinition = {
  id: "iris",
  label: "Iris",
  appearance: "light",
  colors: {
    canvas: "oklch(0.976531 0.003855 303.226)",
    surface: "oklch(0.976531 0.003855 303.226)",
    surfaceRaised: "oklch(0.953326 0.004536 307.676)",
    surfaceOverlay: "oklch(0.936665 0.005041 310.132)",
    text: "oklch(0.222003 0.03479 328.979)",
    border: "oklch(0.869608 0.018226 303.859)",
    input: "oklch(0.834773 0.023405 303.676)",
    accent: "oklch(0.525348 0.15373 294.176)",
    secondary: "oklch(0.941387 0.014687 300.474)",
    mutedForeground: "oklch(0.529955 0.022319 321.556)",
    error: "oklch(0.637823 0.237287 25.436)",
    warning: "oklch(0.772406 0.172798 65.367)",
    accentSurface: "oklch(0.914882 0.022965 299.986)",
    messageSurface: "oklch(0.897143 0.028558 299.758)",
    messageAction: "oklch(0.516084 0.185229 340.776)",
    codeBackground: "oklch(0.95997 0.004338 306.542)",
    sidebar: "oklch(0.941387 0.014687 300.474)",
    sidebarControlSurface: "oklch(0.890512 0.0155 303.803)",
    sidebarRowSelected: "oklch(0.843236 0.045818 299.198)",
    terminalBackground: "oklch(0.976531 0.003855 303.226)",
  },
  variants: {
    dark: {
      canvas: "oklch(0.225975 0.031062 293.741)",
      surface: "oklch(0.225975 0.031062 293.741)",
      surfaceRaised: "oklch(0.335291 0.026008 296.394)",
      surfaceOverlay: "oklch(0.386739 0.024023 297.509)",
      text: "oklch(0.990339 0.008411 325.64)",
      border: "oklch(0.40874 0.058536 295.893)",
      input: "oklch(0.46756 0.065775 296.265)",
      accent: "oklch(0.671712 0.169136 293.929)",
      secondary: "oklch(0.325405 0.063614 294.23)",
      mutedForeground: "oklch(0.663321 0.025932 301.862)",
      error: "oklch(0.655108 0.221148 23.473)",
      warning: "oklch(0.772406 0.172798 65.367)",
      accentSurface: "oklch(0.372436 0.07841 294.204)",
      messageSurface: "oklch(0.399975 0.086965 294.177)",
      messageAction: "oklch(0.789904 0.130063 337.621)",
      codeBackground: "oklch(0.281873 0.028308 295.193)",
      sidebar: "oklch(0.266743 0.044689 294.138)",
      sidebarControlSurface: "oklch(0.399977 0.035678 297.031)",
      sidebarRowSelected: "oklch(0.372806 0.078525 294.203)",
      terminalBackground: "oklch(0.225975 0.031062 293.741)",
    },
  },
  sidebarArtwork: true,
};

export const BUILT_IN_THEMES: ReadonlyArray<ThemeDefinition> = [
  T3_CHAT_THEME,
  GROVE_THEME,
  OCEAN_THEME,
  EMBER_THEME,
  IRIS_THEME,
];

export function getBuiltInTheme(id: string): ThemeDefinition | null {
  return BUILT_IN_THEMES.find((theme) => theme.id === id) ?? null;
}

export function getThemeColorsForAppearance(
  theme: ThemeDefinition,
  appearance: ThemeAppearance,
): ThemeColors | null {
  if (theme.appearance === appearance) return theme.colors;
  return theme.variants?.[appearance] ?? null;
}
