const fs = require("node:fs");
const path = require("node:path");
const {
  AndroidConfig,
  withAndroidColors,
  withAndroidColorsNight,
  withAndroidStyles,
  withDangerousMod,
} = require("expo/config-plugins");

// @react-native-menu/menu renders an AppCompat PopupMenu on Android, which
// inherits the dated default popup chrome from the app theme. These resources
// restyle it to match the app palette (global.css --color-card / --color-foreground)
// with rounded corners, and anchor it below the button instead of overlapping it.

const POPUP_BACKGROUND_DRAWABLE = `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
  <solid android:color="@color/popup_menu_background" />
  <corners android:radius="12dp" />
</shape>
`;

// Checkable menu rows insert a CheckBox at the row's right edge; the theme
// swaps its square-box button for this check glyph so the selected option
// shows a plain right-aligned check.
const CHECK_DRAWABLE = `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="18dp"
    android:height="18dp"
    android:viewportWidth="24"
    android:viewportHeight="24"
    android:tint="@color/popup_menu_item_text">
  <path
      android:fillColor="#FFFFFFFF"
      android:pathData="M9,16.17L4.83,12l-1.42,1.41L9,19 21,7l-1.41,-1.41z" />
</vector>
`;

// CheckBox button drawable: check glyph when selected, nothing otherwise.
const CHECKBOX_BUTTON_SELECTOR = `<?xml version="1.0" encoding="utf-8"?>
<selector xmlns:android="http://schemas.android.com/apk/res/android">
  <item android:state_checked="true" android:drawable="@drawable/ic_menu_check" />
  <item android:drawable="@android:color/transparent" />
</selector>
`;

// Replaces the default filled-triangle submenu indicator with a stroked ">"
// chevron.
const SUBMENU_ARROW_DRAWABLE = `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="20dp"
    android:height="20dp"
    android:viewportWidth="24"
    android:viewportHeight="24"
    android:alpha="0.6"
    android:tint="@color/popup_menu_item_text">
  <path
      android:pathData="M9,6l6,6l-6,6"
      android:strokeColor="#FFFFFFFF"
      android:strokeWidth="2"
      android:strokeLineCap="round"
      android:strokeLineJoin="round"
      android:fillColor="#00000000" />
</vector>
`;

const COLORS = {
  light: { background: "#F7F7F7", itemText: "#262626" },
  night: { background: "#161616", itemText: "#F5F5F5" },
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

function withPopupMenuStyles(config) {
  return withAndroidStyles(config, (config) => {
    const resources = config.modResults.resources;
    resources.style = resources.style ?? [];

    const appTheme = resources.style.find((style) => style.$?.name === "AppTheme");
    if (appTheme) {
      assignStyleItem(appTheme, "popupMenuStyle", "@style/AppPopupMenu");
      assignStyleItem(appTheme, "android:popupMenuStyle", "@style/AppPopupMenu");
      assignStyleItem(
        appTheme,
        "textAppearanceLargePopupMenu",
        "@style/AppPopupMenu.TextAppearance",
      );
      assignStyleItem(
        appTheme,
        "textAppearanceSmallPopupMenu",
        "@style/AppPopupMenu.TextAppearance",
      );
      // Submenu popups show their parent item as a header row that reads a
      // separate theme attribute, so it needs the same themed text color.
      assignStyleItem(
        appTheme,
        "textAppearancePopupMenuHeader",
        "@style/AppPopupMenu.HeaderTextAppearance",
      );
      // Menu item views resolve their submenu arrow from this style
      // (android:listMenuViewStyle / android:subMenuArrow are public attrs).
      assignStyleItem(appTheme, "android:listMenuViewStyle", "@style/AppPopupMenuListMenuView");
      // Checkable rows inflate a plain CheckBox at the row end; restyle its
      // button so the selected option shows a right-aligned check glyph
      // instead of a square box. Both framework and AppCompat attrs are set
      // since the popup may inflate either CheckBox flavor. App-wide for
      // native checkboxes, which the app otherwise doesn't use.
      assignStyleItem(appTheme, "android:checkboxStyle", "@style/AppPopupMenuCheckBox");
      assignStyleItem(appTheme, "checkboxStyle", "@style/AppPopupMenuCheckBoxCompat");
    }

    resources.style = resources.style.filter(
      (style) =>
        ![
          "AppPopupMenu",
          "AppPopupMenu.TextAppearance",
          "AppPopupMenu.HeaderTextAppearance",
          "AppPopupMenuListMenuView",
          "AppPopupMenuCheckBox",
          "AppPopupMenuCheckBoxCompat",
        ].includes(style.$?.name),
    );
    resources.style.push(
      {
        $: { name: "AppPopupMenu", parent: "Widget.AppCompat.PopupMenu" },
        item: [
          { _: "@drawable/popup_menu_background", $: { name: "android:popupBackground" } },
          { _: "false", $: { name: "android:overlapAnchor" } },
          { _: "4dp", $: { name: "android:dropDownVerticalOffset" } },
        ],
      },
      {
        $: { name: "AppPopupMenu.TextAppearance", parent: "TextAppearance.AppCompat.Menu" },
        item: [
          { _: "15sp", $: { name: "android:textSize" } },
          { _: "@color/popup_menu_item_text", $: { name: "android:textColor" } },
          // DM Sans (--font-sans); embedded by the expo-font plugin config in
          // app.config.ts.
          { _: "@font/xml_dm_sans_regular", $: { name: "android:fontFamily" } },
        ],
      },
      {
        $: {
          name: "AppPopupMenu.HeaderTextAppearance",
          parent: "TextAppearance.AppCompat.Widget.PopupMenu.Header",
        },
        item: [
          { _: "15sp", $: { name: "android:textSize" } },
          { _: "@color/popup_menu_item_text", $: { name: "android:textColor" } },
          { _: "@font/xml_dm_sans_regular", $: { name: "android:fontFamily" } },
        ],
      },
      // The framework default (Widget.Material.ListMenuView) only carries
      // subMenuArrow, so replacing the style wholesale is safe.
      {
        $: { name: "AppPopupMenuListMenuView" },
        item: [{ _: "@drawable/popup_menu_submenu_arrow", $: { name: "android:subMenuArrow" } }],
      },
      {
        $: {
          name: "AppPopupMenuCheckBox",
          parent: "android:Widget.Material.CompoundButton.CheckBox",
        },
        item: [{ _: "@drawable/popup_menu_check_button", $: { name: "android:button" } }],
      },
      {
        $: {
          name: "AppPopupMenuCheckBoxCompat",
          parent: "Widget.AppCompat.CompoundButton.CheckBox",
        },
        item: [
          { _: "@drawable/popup_menu_check_button", $: { name: "android:button" } },
          // buttonCompat wins over android:button in AppCompatCheckBox.
          { _: "@drawable/popup_menu_check_button", $: { name: "buttonCompat" } },
        ],
      },
    );

    return config;
  });
}

function withPopupMenuColors(config) {
  config = withAndroidColors(config, (config) => {
    config.modResults = AndroidConfig.Colors.assignColorValue(config.modResults, {
      name: "popup_menu_background",
      value: COLORS.light.background,
    });
    config.modResults = AndroidConfig.Colors.assignColorValue(config.modResults, {
      name: "popup_menu_item_text",
      value: COLORS.light.itemText,
    });
    return config;
  });
  config = withAndroidColorsNight(config, (config) => {
    config.modResults = AndroidConfig.Colors.assignColorValue(config.modResults, {
      name: "popup_menu_background",
      value: COLORS.night.background,
    });
    config.modResults = AndroidConfig.Colors.assignColorValue(config.modResults, {
      name: "popup_menu_item_text",
      value: COLORS.night.itemText,
    });
    return config;
  });
  return config;
}

function withPopupMenuBackgroundDrawable(config) {
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
        path.join(drawableDir, "popup_menu_background.xml"),
        POPUP_BACKGROUND_DRAWABLE,
      );
      fs.writeFileSync(path.join(drawableDir, "ic_menu_check.xml"), CHECK_DRAWABLE);
      fs.writeFileSync(
        path.join(drawableDir, "popup_menu_check_button.xml"),
        CHECKBOX_BUTTON_SELECTOR,
      );
      fs.writeFileSync(
        path.join(drawableDir, "popup_menu_submenu_arrow.xml"),
        SUBMENU_ARROW_DRAWABLE,
      );
      return config;
    },
  ]);
}

module.exports = function withAndroidModernPopupMenu(config) {
  return withPopupMenuBackgroundDrawable(withPopupMenuColors(withPopupMenuStyles(config)));
};
