plugins {
  id("com.android.library")
}

val sharedReview = file("../../mobile/modules/t3-review-diff/android")

android {
  namespace = "expo.modules.t3reviewdiff"
  compileSdk = 37

  defaultConfig {
    minSdk = 26
  }
}

androidComponents {
  onVariants { variant ->
    variant.sources.kotlin?.addStaticSourceDirectory(sharedReview.resolve("src/main/java").path)
  }
}

tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
  exclude("**/T3ReviewDiffModule.kt", "**/T3ReviewDiffView.kt")
}
