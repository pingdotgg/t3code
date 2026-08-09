plugins {
  kotlin("jvm")
  kotlin("plugin.serialization")
  application
}

kotlin {
  jvmToolchain(17)
}

dependencies {
  implementation("com.squareup.okhttp3:okhttp:4.12.0")
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.11.0")
  implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")

  testImplementation(kotlin("test-junit5"))
  testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
  testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.11.0")
  testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

application {
  mainClass.set("com.t3tools.android.protocol.harness.MainKt")
}

tasks.test {
  useJUnitPlatform()
}
