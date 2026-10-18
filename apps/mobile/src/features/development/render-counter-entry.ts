// Production builds fold this condition to false before Metro collects
// dependencies, so the counter module never enters a release bundle.
if (__DEV__ && process.env.EXPO_PUBLIC_T3_RENDER_COUNTER === "1") {
  require("./render-counter");
}
