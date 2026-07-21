FROM --platform=linux/amd64 node:24.13.1-bookworm AS builder

ARG ANDROID_CMDLINE_TOOLS=11076708
ENV ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 \
    PATH=/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:/root/.bun/bin:$PATH \
    APP_VARIANT=preview \
    EXPO_NO_GIT_STATUS=1 \
    NODE_OPTIONS=--max-old-space-size=4096 \
    GRADLE_OPTS=-Dorg.gradle.jvmargs=-Xmx6144m

RUN apt-get update \
    && apt-get install -y --no-install-recommends openjdk-17-jdk-headless curl unzip git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/android-sdk/cmdline-tools \
    && curl -fsSL "https://dl.google.com/android/repository/commandlinetools-linux-${ANDROID_CMDLINE_TOOLS}_latest.zip" -o /tmp/android-tools.zip \
    && unzip -q /tmp/android-tools.zip -d /opt/android-sdk/cmdline-tools \
    && mv /opt/android-sdk/cmdline-tools/cmdline-tools /opt/android-sdk/cmdline-tools/latest \
    && rm /tmp/android-tools.zip \
    && yes | sdkmanager --licenses >/dev/null \
    && sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0" "ndk;27.1.12297006" "cmake;3.22.1" \
    && curl -fsSL https://bun.sh/install | bash -s -- bun-v1.3.11

WORKDIR /src
COPY . .

RUN corepack enable \
    && corepack prepare pnpm@11.10.0 --activate \
    && pnpm config set network-concurrency 8 \
    && pnpm config set child-concurrency 2 \
    && pnpm install --filter @t3tools/mobile... --frozen-lockfile
RUN cd apps/mobile \
    && npx expo prebuild --clean --platform android \
    && cd android \
    && ./gradlew --no-daemon --max-workers=3 :app:assembleRelease \
      -Pkotlin.compiler.execution.strategy=in-process \
      -Dorg.gradle.internal.instrumentation.agent=false \
      -PreactNativeArchitectures=arm64-v8a \
    && mkdir -p /artifact \
    && cp app/build/outputs/apk/release/app-release.apk /artifact/t3-code-preview.apk

FROM nginx:1.29-alpine
COPY docker/android/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/android/index.html /usr/share/nginx/html/index.html
COPY --from=builder /artifact/t3-code-preview.apk /usr/share/nginx/html/t3-code-preview.apk
EXPOSE 80
