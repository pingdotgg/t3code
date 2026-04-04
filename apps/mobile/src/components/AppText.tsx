import {
  Text as RNText,
  type StyleProp,
  TextInput as RNTextInput,
  type TextInputProps as RNTextInputProps,
  type TextProps as RNTextProps,
  type TextStyle,
  useColorScheme,
  type ViewStyle,
} from "react-native";

type ClassNameProp = {
  readonly className?: string;
};

const colorMap = {
  "text-white": "#ffffff",
  "text-slate-50": "#f8fafc",
  "text-slate-300": "#cbd5e1",
  "text-slate-400": "#94a3b8",
  "text-slate-500": "#64748b",
  "text-slate-600": "#475569",
  "text-slate-700": "#334155",
  "text-slate-950": "#020617",
  "text-orange-300": "#fdba74",
  "text-orange-600": "#ea580c",
  "text-orange-700": "#c2410c",
  "text-emerald-300": "#6ee7b7",
  "text-emerald-700": "#047857",
  "text-rose-300": "#fda4af",
  "text-rose-700": "#be123c",
  "text-sky-300": "#7dd3fc",
  "text-sky-700": "#0369a1",
} satisfies Record<string, string>;

const backgroundColorMap = {
  "bg-white": "#ffffff",
  "bg-slate-900": "#0f172a",
  "bg-slate-950/70": "rgba(2, 6, 23, 0.7)",
} satisfies Record<string, string>;

const borderColorMap = {
  "border-slate-200": "#e2e8f0",
  "border-white/8": "rgba(255, 255, 255, 0.08)",
} satisfies Record<string, string>;

function activeToken(token: string, isDarkMode: boolean) {
  if (!token.startsWith("dark:")) {
    return token;
  }

  return isDarkMode ? token.slice(5) : null;
}

function resolveTextStyle(className: string | undefined, isDarkMode: boolean): TextStyle {
  const style: TextStyle = {
    color: isDarkMode ? "#f8fafc" : "#020617",
  };

  let hasLeadingNone = false;
  for (const rawToken of className?.split(/\s+/) ?? []) {
    const token = activeToken(rawToken, isDarkMode);
    if (!token) {
      continue;
    }

    if (token in colorMap) {
      style.color = colorMap[token as keyof typeof colorMap];
      continue;
    }

    if (token === "font-sans") {
      style.fontWeight = "400";
      continue;
    }

    if (token === "font-medium") {
      style.fontWeight = "500";
      continue;
    }

    if (token === "font-bold") {
      style.fontWeight = "700";
      continue;
    }

    if (token === "font-extrabold") {
      style.fontWeight = "800";
      continue;
    }

    if (token === "font-t3-medium") {
      style.fontWeight = "500";
      continue;
    }

    if (token === "font-t3-bold") {
      style.fontWeight = "700";
      continue;
    }

    if (token === "font-t3-extrabold") {
      style.fontWeight = "800";
      continue;
    }

    if (token === "text-xs") {
      style.fontSize = 12;
      continue;
    }

    if (token === "text-sm") {
      style.fontSize = 14;
      continue;
    }

    if (token === "text-lg") {
      style.fontSize = 18;
      continue;
    }

    if (token === "leading-none") {
      hasLeadingNone = true;
      continue;
    }

    if (token === "leading-5") {
      style.lineHeight = 20;
      continue;
    }

    if (token === "uppercase") {
      style.textTransform = "uppercase";
      continue;
    }

    if (token === "capitalize") {
      style.textTransform = "capitalize";
      continue;
    }

    if (token === "mt-2") {
      style.marginTop = 8;
      continue;
    }

    if (token === "pt-1.5") {
      style.paddingTop = 6;
      continue;
    }

    if (token === "pb-1") {
      style.paddingBottom = 4;
      continue;
    }

    if (token === "max-w-[640px]") {
      style.maxWidth = 640;
      continue;
    }

    const pxValue = token.match(/^text-\[(\d+)px\]$/);
    if (pxValue) {
      style.fontSize = Number(pxValue[1]);
      continue;
    }

    const lineHeightValue = token.match(/^leading-\[(\d+)px\]$/);
    if (lineHeightValue) {
      style.lineHeight = Number(lineHeightValue[1]);
      continue;
    }

    const trackingValue = token.match(/^tracking-\[([0-9.]+)px\]$/);
    if (trackingValue) {
      style.letterSpacing = Number(trackingValue[1]);
    }
  }

  if (hasLeadingNone) {
    style.lineHeight = style.fontSize ?? 16;
  }

  return style;
}

function resolveTextInputStyle(
  className: string | undefined,
  isDarkMode: boolean,
): ViewStyle & TextStyle {
  const style: ViewStyle & TextStyle = {
    color: isDarkMode ? "#f8fafc" : "#020617",
    backgroundColor: isDarkMode ? "#0f172a" : "#ffffff",
    borderColor: isDarkMode ? "rgba(255, 255, 255, 0.08)" : "#e2e8f0",
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    minHeight: 54,
  };

  for (const rawToken of className?.split(/\s+/) ?? []) {
    const token = activeToken(rawToken, isDarkMode);
    if (!token) {
      continue;
    }

    if (token in colorMap) {
      style.color = colorMap[token as keyof typeof colorMap];
      continue;
    }

    if (token in backgroundColorMap) {
      style.backgroundColor = backgroundColorMap[token as keyof typeof backgroundColorMap];
      continue;
    }

    if (token in borderColorMap) {
      style.borderColor = borderColorMap[token as keyof typeof borderColorMap];
      continue;
    }

    if (token === "border") {
      style.borderWidth = 1;
      continue;
    }

    if (token === "rounded-2xl") {
      style.borderRadius = 16;
      continue;
    }

    if (token === "rounded-[18px]") {
      style.borderRadius = 18;
      continue;
    }

    if (token === "px-3.5") {
      style.paddingHorizontal = 14;
      continue;
    }

    if (token === "py-3") {
      style.paddingVertical = 12;
      continue;
    }

    if (token === "py-3.5") {
      style.paddingVertical = 14;
      continue;
    }

    if (token === "font-sans") {
      style.fontWeight = "400";
      continue;
    }

    if (token === "text-sm") {
      style.fontSize = 14;
      continue;
    }

    const minHeightValue = token.match(/^min-h-\[(\d+)px\]$/);
    if (minHeightValue) {
      style.minHeight = Number(minHeightValue[1]);
      continue;
    }

    const maxHeightValue = token.match(/^max-h-\[(\d+)px\]$/);
    if (maxHeightValue) {
      style.maxHeight = Number(maxHeightValue[1]);
      continue;
    }

    const textPxValue = token.match(/^text-\[(\d+)px\]$/);
    if (textPxValue) {
      style.fontSize = Number(textPxValue[1]);
      continue;
    }

    const lineHeightValue = token.match(/^leading-\[(\d+)px\]$/);
    if (lineHeightValue) {
      style.lineHeight = Number(lineHeightValue[1]);
    }
  }

  return style;
}

export type AppTextProps = RNTextProps & ClassNameProp;

export function AppText({ className, style, ...props }: AppTextProps) {
  const isDarkMode = useColorScheme() === "dark";
  return <RNText {...props} style={[resolveTextStyle(className, isDarkMode), style]} />;
}

export type AppTextInputProps = RNTextInputProps & ClassNameProp;

export function AppTextInput({
  className,
  placeholderTextColor,
  style,
  ...props
}: AppTextInputProps) {
  const isDarkMode = useColorScheme() === "dark";
  const resolvedStyle = resolveTextInputStyle(className, isDarkMode);

  return (
    <RNTextInput
      {...props}
      placeholderTextColor={placeholderTextColor ?? (isDarkMode ? "#94a3b8" : "#64748b")}
      style={[resolvedStyle as StyleProp<TextStyle>, style]}
    />
  );
}
