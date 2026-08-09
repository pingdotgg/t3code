plugins {
  id("com.android.library")
  kotlin("android")
}

val sharedReview = file("../../mobile/modules/t3-review-diff/android")

android {
  namespace = "expo.modules.t3reviewdiff"
  compileSdk = 35

  defaultConfig {
    minSdk = 26
  }
}

kotlin {
  jvmToolchain(17)
  sourceSets.named("main") {
    kotlin.srcDir(sharedReview.resolve("src/main/java"))
    kotlin.exclude("**/T3ReviewDiffModule.kt", "**/T3ReviewDiffView.kt")
  }
}
