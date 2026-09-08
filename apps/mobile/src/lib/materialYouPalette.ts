export interface MaterialYouPalette {
  readonly primary: string;
  readonly onPrimary: string;
  readonly primaryContainer: string;
  readonly onPrimaryContainer: string;
  readonly inversePrimary: string;
  readonly secondaryContainer: string;
  readonly onSecondaryContainer: string;
  readonly tertiary: string;
  readonly tertiaryContainer: string;
  readonly onTertiaryContainer: string;
  readonly surface: string;
  readonly onSurface: string;
  readonly onSurfaceVariant: string;
  readonly surfaceContainer: string;
  readonly surfaceContainerHigh: string;
  readonly surfaceContainerHighest: string;
  readonly surfaceContainerLow: string;
  readonly surfaceContainerLowest: string;
  readonly errorContainer: string;
  readonly onErrorContainer: string;
  readonly outline: string;
  readonly outlineVariant: string;
  readonly scrim: string;
}

export interface MaterialYouPalettes {
  readonly light: MaterialYouPalette;
  readonly dark: MaterialYouPalette;
}

export const isSystemColorsAvailable = false;

export function readSystemColorPalettes(): MaterialYouPalettes | null {
  return null;
}
