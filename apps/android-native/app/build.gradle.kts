plugins {
  id("com.android.application")
  kotlin("android")
  kotlin("plugin.compose")
  kotlin("plugin.serialization")
}

android {
  namespace = "com.t3tools.android.nativeapp"
  compileSdk = 35

  defaultConfig {
    applicationId = "com.t3tools.t3code.native.experimental"
    minSdk = 26
    targetSdk = 35
    versionCode = 1
    versionName = "0.4.0-phase3d"
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  buildFeatures {
    compose = true
    buildConfig = true
  }

  defaultConfig {
    buildConfigField("String", "T3_CLERK_PUBLISHABLE_KEY", "\"pk_live_Y2xlcmsudDMuY29kZXMk\"")
    buildConfigField("String", "T3_CLERK_JWT_TEMPLATE", "\"t3-relay\"")
    buildConfigField("String", "T3_RELAY_URL", "\"https://relay.t3.codes\"")
  }

  packaging {
    resources.excludes += setOf(
      "/META-INF/{AL2.0,LGPL2.1}",
      "META-INF/versions/9/OSGI-INF/MANIFEST.MF",
    )
  }
}

kotlin {
  jvmToolchain(17)
}

dependencies {
  implementation(project(":protocol"))
  implementation(project(":terminal-renderer"))
  implementation(project(":review-renderer"))
  implementation(platform("androidx.compose:compose-bom:2024.12.01"))
  implementation("androidx.activity:activity-compose:1.10.0")
  implementation("androidx.compose.foundation:foundation")
  implementation("androidx.compose.material3:material3")
  implementation("androidx.compose.material:material-icons-extended")
  implementation("androidx.compose.ui:ui")
  implementation("androidx.compose.ui:ui-tooling-preview")
  implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
  implementation("androidx.lifecycle:lifecycle-process:2.8.7")
  implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
  implementation("androidx.navigation:navigation-compose:2.8.5")
  implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
  implementation("com.clerk:clerk-android-api:1.0.10")
  // UI package pulls navigation3 (compileSdk 36 / AGP 8.9). Use API + Custom Tabs for sign-in.
  implementation("com.squareup.okhttp3:okhttp:4.12.0")
  implementation("io.coil-kt:coil-compose:2.7.0")
  implementation("io.coil-kt:coil-svg:2.7.0")
  implementation("io.noties.markwon:core:4.6.2")
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.1")
  implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")

  testImplementation("junit:junit:4.13.2")
  testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.1")
  androidTestImplementation("androidx.test.ext:junit:1.2.1")
  androidTestImplementation("androidx.test:runner:1.6.2")
  androidTestImplementation(platform("androidx.compose:compose-bom:2024.12.01"))
  androidTestImplementation("androidx.compose.ui:ui-test-junit4")
  debugImplementation("androidx.compose.ui:ui-tooling")
  debugImplementation("androidx.compose.ui:ui-test-manifest")
}

configurations.configureEach {
  resolutionStrategy {
    force(
      "org.jetbrains.kotlin:kotlin-stdlib:2.3.10",
      "org.jetbrains.kotlin:kotlin-stdlib-jdk7:2.3.10",
      "org.jetbrains.kotlin:kotlin-stdlib-jdk8:2.3.10",
      "androidx.browser:browser:1.8.0",
      "androidx.activity:activity:1.10.1",
      "androidx.activity:activity-ktx:1.10.1",
      "androidx.activity:activity-compose:1.10.0",
      "androidx.lifecycle:lifecycle-runtime-compose:2.8.7",
      "androidx.lifecycle:lifecycle-runtime-ktx:2.8.7",
      "androidx.lifecycle:lifecycle-process:2.8.7",
      "androidx.lifecycle:lifecycle-viewmodel-ktx:2.8.7",
      "androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7",
    )
  }
}
