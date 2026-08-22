plugins {
  id("com.android.library")
}

val sharedTerminal = file("../../mobile/modules/t3-terminal/android")

android {
  namespace = "expo.modules.t3terminal"
  compileSdk = 37
  ndkVersion = "27.0.12077973"

  defaultConfig {
    minSdk = 26

    externalNativeBuild {
      cmake {
        cppFlags += listOf("-std=c++17", "-Wall", "-Wextra", "-Werror")
      }
    }
  }

  externalNativeBuild {
    cmake {
      path = sharedTerminal.resolve("src/main/cpp/CMakeLists.txt")
      version = "3.22.1"
    }
  }

}

androidComponents {
  onVariants { variant ->
    variant.sources.assets?.addStaticSourceDirectory(sharedTerminal.resolve("src/main/assets").path)
    variant.sources.jniLibs?.addStaticSourceDirectory(sharedTerminal.resolve("src/main/jniLibs").path)
    variant.sources.kotlin?.addStaticSourceDirectory(sharedTerminal.resolve("src/main/java").path)
  }
}

tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
  exclude("**/T3TerminalModule.kt", "**/T3TerminalView.kt")
}
