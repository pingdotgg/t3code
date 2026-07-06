const fs = require("node:fs");
const path = require("node:path");
const {
  AndroidConfig,
  withAndroidColors,
  withAndroidColorsNight,
  withAndroidStyles,
  withDangerousMod,
} = require("expo/config-plugins");

// React Native's Alert renders an AppCompat AlertDialog on Android, which
// inherits the dated framework dialog chrome (square gray panel, teal
// all-caps buttons) from the app theme. These resources restyle it with the
// app's uniwind tokens from global.css: --color-card panel, --color-foreground
// text, --color-primary buttons, DM Sans type. The @font resources referenced
// here are embedded by the expo-font plugin config in app.config.ts.

// AppCompat's default dialog window background is an inset rounded rect, so
// the replacement keeps the same 16dp inset to preserve the dialog's margins.
const DIALOG_BACKGROUND_DRAWABLE = `<?xml version="1.0" encoding="utf-8"?>
<inset xmlns:android="http://schemas.android.com/apk/res/android"
    android:insetLeft="16dp"
    android:insetTop="16dp"
    android:insetRight="16dp"
    android:insetBottom="16dp">
  <shape android:shape="rectangle">
    <solid android:color="@color/alert_dialog_background" />
    <corners android:radius="24dp" />
  </shape>
</inset>
`;

const COLORS = {
  light: {
    background: "#FFFFFF", // --color-card
    text: "#262626", // --color-foreground
    secondaryText: "#525252", // --color-foreground-secondary
    buttonText: "#262626", // --color-primary
  },
  night: {
    background: "#171717",
    text: "#F5F5F5",
    secondaryText: "#A3A3A3",
    buttonText: "#F5F5F5",
  },
};

function assignStyleItem(style, name, value) {
  style.item = style.item ?? [];
  const existing = style.item.find((item) => item.$?.name === name);
  if (existing) {
    existing._ = value;
  } else {
    style.item.push({ _: value, $: { name } });
  }
}

function withAlertDialogStyles(config) {
  return withAndroidStyles(config, (config) => {
    const resources = config.modResults.resources;
    resources.style = resources.style ?? [];

    const appTheme = resources.style.find((style) => style.$?.name === "AppTheme");
    if (appTheme) {
      // React Native's dialog module builds an androidx.appcompat AlertDialog,
      // which resolves its theme from the AppCompat attr; the framework attr is
      // set too for any native code that inflates a platform AlertDialog.
      assignStyleItem(appTheme, "alertDialogTheme", "@style/AppAlertDialog");
      assignStyleItem(appTheme, "android:alertDialogTheme", "@style/AppAlertDialog");
    }

    resources.style = resources.style.filter(
      (style) =>
        !["AppAlertDialog", "AppAlertDialog.Title", "AppAlertDialog.Button"].includes(
          style.$?.name,
        ),
    );
    resources.style.push(
      {
        $: { name: "AppAlertDialog", parent: "ThemeOverlay.AppCompat.Dialog.Alert" },
        item: [
          { _: "@drawable/alert_dialog_background", $: { name: "android:windowBackground" } },
          // The message body resolves textColorPrimary in AppCompat's alert
          // layout; pointing it at the secondary token dims the message
          // relative to the title, which keeps full-strength text via the
          // explicit color in AppAlertDialog.Title.
          { _: "@color/alert_dialog_secondary_text", $: { name: "android:textColorPrimary" } },
          { _: "@color/alert_dialog_secondary_text", $: { name: "android:textColorSecondary" } },
          // Theme-level fontFamily is the lowest-priority fallback in attribute
          // resolution, so it reaches every text view in the dialog that does
          // not carry its own fontFamily (the message body in particular).
          { _: "@font/xml_dm_sans", $: { name: "android:fontFamily" } },
          // AppCompat's alert title view styles itself from the framework
          // attr (?android:attr/windowTitleStyle); there is no unprefixed
          // AppCompat equivalent.
          { _: "@style/AppAlertDialog.Title", $: { name: "android:windowTitleStyle" } },
          { _: "@style/AppAlertDialog.Button", $: { name: "buttonBarPositiveButtonStyle" } },
          { _: "@style/AppAlertDialog.Button", $: { name: "buttonBarNegativeButtonStyle" } },
          { _: "@style/AppAlertDialog.Button", $: { name: "buttonBarNeutralButtonStyle" } },
        ],
      },
      {
        $: { name: "AppAlertDialog.Title", parent: "RtlOverlay.DialogWindowTitle.AppCompat" },
        item: [
          { _: "@font/dm_sans_500medium", $: { name: "android:fontFamily" } },
          { _: "18sp", $: { name: "android:textSize" } },
          { _: "@color/alert_dialog_text", $: { name: "android:textColor" } },
        ],
      },
      {
        $: {
          name: "AppAlertDialog.Button",
          parent: "Widget.AppCompat.Button.ButtonBar.AlertDialog",
        },
        item: [
          // The AppCompat button appearance hardcodes sans-serif-medium, so
          // the font must be set here rather than relying on the theme
          // fallback.
          { _: "@font/dm_sans_500medium", $: { name: "android:fontFamily" } },
          { _: "@color/alert_dialog_button_text", $: { name: "android:textColor" } },
          { _: "false", $: { name: "android:textAllCaps" } },
          { _: "0", $: { name: "android:letterSpacing" } },
        ],
      },
    );

    return config;
  });
}

function assignColors(colorsResource, palette) {
  let result = colorsResource;
  result = AndroidConfig.Colors.assignColorValue(result, {
    name: "alert_dialog_background",
    value: palette.background,
  });
  result = AndroidConfig.Colors.assignColorValue(result, {
    name: "alert_dialog_text",
    value: palette.text,
  });
  result = AndroidConfig.Colors.assignColorValue(result, {
    name: "alert_dialog_secondary_text",
    value: palette.secondaryText,
  });
  result = AndroidConfig.Colors.assignColorValue(result, {
    name: "alert_dialog_button_text",
    value: palette.buttonText,
  });
  return result;
}

function withAlertDialogColors(config) {
  config = withAndroidColors(config, (config) => {
    config.modResults = assignColors(config.modResults, COLORS.light);
    return config;
  });
  config = withAndroidColorsNight(config, (config) => {
    config.modResults = assignColors(config.modResults, COLORS.night);
    return config;
  });
  return config;
}

function withAlertDialogBackgroundDrawable(config) {
  return withDangerousMod(config, [
    "android",
    async (config) => {
      const drawableDir = path.join(
        config.modRequest.platformProjectRoot,
        "app",
        "src",
        "main",
        "res",
        "drawable",
      );
      fs.mkdirSync(drawableDir, { recursive: true });
      fs.writeFileSync(
        path.join(drawableDir, "alert_dialog_background.xml"),
        DIALOG_BACKGROUND_DRAWABLE,
      );
      return config;
    },
  ]);
}

module.exports = function withAndroidModernAlertDialog(config) {
  return withAlertDialogBackgroundDrawable(withAlertDialogColors(withAlertDialogStyles(config)));
};
