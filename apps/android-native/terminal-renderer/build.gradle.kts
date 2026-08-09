plugins {
  id("com.android.library")
  kotlin("android")
}

val sharedTerminal = file("../../mobile/modules/t3-terminal/android")

android {
  namespace = "expo.modules.t3terminal"
  compileSdk = 37

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

  sourceSets {
    named("main") {
      assets.srcDir(sharedTerminal.resolve("src/main/assets"))
      jniLibs.srcDir(sharedTerminal.resolve("src/main/jniLibs"))
    }
  }
}

kotlin {
  jvmToolchain(17)
  sourceSets.named("main") {
    kotlin.srcDir(sharedTerminal.resolve("src/main/java"))
  }
}

tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
  exclude("**/T3TerminalModule.kt", "**/T3TerminalView.kt")
}
