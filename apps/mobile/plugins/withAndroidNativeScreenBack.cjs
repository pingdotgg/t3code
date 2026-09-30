const { withMainActivity } = require("expo/config-plugins");

// Android back normally reaches the navigator through JS: the press is queued
// on the JS thread, React Navigation pops, and only then does the screen stack
// animate. While JS is busy (a thread loading or syncing) back does nothing
// until that work finishes. This callback pops the top screen on the UI thread
// instead when the screen opted in (native-stack's
// unstable_nativeBackDismissalEnabled), the same native dismissal an iOS swipe
// back uses: JS learns of it through onDismissed and updates its state then.
// Everything else still goes to JS, including back while in-window UI that
// handles back in JS is on screen (marked with JS_BACK_HANDLER_NATIVE_ID).

const JS_BACK_HANDLER_NATIVE_ID = "t3-js-back-handler";

const IMPORTS = `
import android.view.View
import android.view.ViewGroup
import com.facebook.react.uimanager.util.ReactFindViewUtil
import com.swmansion.rnscreens.ScreenStack
import com.swmansion.rnscreens.ScreenStackFragmentWrapper`;

const CALLBACK_PROPERTY = `
  // Pops an opted-in screen without waiting for JS; everything else is handed
  // on to React Native's callback. Registered in onPostCreate, after React
  // Native's own, so it runs first; added by withAndroidNativeScreenBack.
  private val nativeScreenBackCallback = object : OnBackPressedCallback(true) {
    override fun handleOnBackPressed() {
      val target = nativeScreenBackTarget()
      if (target != null) {
        target.dismissFromContainer()
        return
      }
      isEnabled = false
      try {
        onBackPressedDispatcher.onBackPressed()
      } finally {
        isEnabled = true
      }
    }
  }

  override fun onPostCreate(savedInstanceState: Bundle?) {
    super.onPostCreate(savedInstanceState)
    onBackPressedDispatcher.addCallback(this, nativeScreenBackCallback)
  }

  // The top screen of the innermost stack on screen, if it may be popped natively.
  private fun nativeScreenBackTarget(): ScreenStackFragmentWrapper? {
    // Wide layouts show more than one stack at a time; leave those to JS.
    if (resources.configuration.smallestScreenWidthDp >= 600) return null
    // In-window UI that handles back in JS (an open menu) closes first. It is
    // marked on the view itself, so the check holds from its first frame.
    if (ReactFindViewUtil.findView(window.decorView, JS_BACK_HANDLER_NATIVE_ID) != null) return null
    var stack = findScreenStack(window.decorView, Int.MAX_VALUE) ?: return null
    while (true) {
      val top = stack.topScreen ?: return null
      val nested = findScreenStack(top, NESTED_SCREEN_STACK_DEPTH)
      if (nested?.topScreen != null) {
        stack = nested
        continue
      }
      if (!top.nativeBackButtonDismissalEnabled || stack.rootScreen === top) return null
      return top.fragmentWrapper as? ScreenStackFragmentWrapper
    }
  }

  private fun findScreenStack(root: View, maxDepth: Int): ScreenStack? {
    val views = ArrayDeque<View>()
    val depths = ArrayDeque<Int>()
    views.addLast(root)
    depths.addLast(0)
    while (views.isNotEmpty()) {
      val view = views.removeFirst()
      val depth = depths.removeFirst()
      if (view !== root && view is ScreenStack) return view
      if (view is ViewGroup && depth < maxDepth) {
        for (index in 0 until view.childCount) {
          views.addLast(view.getChildAt(index))
          depths.addLast(depth + 1)
        }
      }
    }
    return null
  }

  private companion object {
    // A nested navigator's stack sits a few views inside its screen.
    const val NESTED_SCREEN_STACK_DEPTH = 10
    // Matches src/lib/androidNativeBack.ts.
    const val JS_BACK_HANDLER_NATIVE_ID = "${JS_BACK_HANDLER_NATIVE_ID}"
  }
`;

// The default action ends in ComponentActivity.onBackPressed(), which
// re-enters the dispatcher; with this callback enabled it would be handed
// straight back to JS instead of backgrounding the app.
const INVOKE_DEFAULT_WRAPPER = `override fun invokeDefaultOnBackPressed() {
    nativeScreenBackCallback.isEnabled = false
    try {
      invokeDefaultOnBackPressedAfterNativeScreenBack()
    } finally {
      nativeScreenBackCallback.isEnabled = true
    }
  }

  private fun invokeDefaultOnBackPressedAfterNativeScreenBack() {`;

function insertAfter(contents, anchor, insertion, description) {
  const index = contents.indexOf(anchor);
  if (index === -1) {
    throw new Error(
      `withAndroidNativeScreenBack: could not find ${description} in MainActivity — the Expo template changed; update the plugin anchors.`,
    );
  }
  const end = index + anchor.length;
  return contents.slice(0, end) + insertion + contents.slice(end);
}

module.exports = function withAndroidNativeScreenBack(config) {
  return withMainActivity(config, (nextConfig) => {
    let contents = nextConfig.modResults.contents;
    if (nextConfig.modResults.language !== "kt") {
      throw new Error("withAndroidNativeScreenBack: MainActivity must be Kotlin.");
    }
    if (contents.includes("nativeScreenBackCallback")) {
      return nextConfig;
    }

    let imports = IMPORTS;
    if (!contents.includes("import androidx.activity.OnBackPressedCallback")) {
      imports = `\nimport androidx.activity.OnBackPressedCallback${imports}`;
    }
    contents = insertAfter(
      contents,
      "import android.os.Bundle",
      imports,
      "the android.os.Bundle import",
    );
    contents = insertAfter(
      contents,
      "class MainActivity : ReactActivity() {",
      CALLBACK_PROPERTY,
      "the MainActivity class declaration",
    );

    if (!contents.includes("override fun invokeDefaultOnBackPressed() {")) {
      throw new Error(
        "withAndroidNativeScreenBack: could not find invokeDefaultOnBackPressed in MainActivity — the Expo template changed; update the plugin anchors.",
      );
    }
    contents = contents.replace(
      "override fun invokeDefaultOnBackPressed() {",
      INVOKE_DEFAULT_WRAPPER,
    );

    nextConfig.modResults.contents = contents;
    return nextConfig;
  });
};
