plugins {
  id("com.android.library")
  kotlin("android")
}

val sharedReview = file("../../mobile/modules/t3-review-diff/android")

android {
  namespace = "expo.modules.t3reviewdiff"
  compileSdk = 37

  defaultConfig {
    minSdk = 26
  }
}

kotlin {
  jvmToolchain(17)
  sourceSets.named("main") {
    kotlin.srcDir(sharedReview.resolve("src/main/java"))
  }
}

tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
  exclude("**/T3ReviewDiffModule.kt", "**/T3ReviewDiffView.kt")
}
