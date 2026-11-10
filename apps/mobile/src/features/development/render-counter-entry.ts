// Metro folds this condition before collecting dependencies, excluding the counter from release bundles.
if (__DEV__ && process.env.EXPO_PUBLIC_T3_RENDER_COUNTER === "1") {
  require("./render-counter");
}
