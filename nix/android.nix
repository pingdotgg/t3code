{
  buildCommit,
  nixpkgs,
  self,
  system,
}: let
  pkgs = import nixpkgs {
    inherit system;
    config = {
      allowUnfree = true;
      android_sdk.accept_license = true;
    };
  };
  lib = pkgs.lib;
  buildToolsVersion = "36.0.0";
  commandLineToolsVersion = "8.0";
  ndkVersion = "27.1.12297006";
  expoNdkVersion = "27.0.12077973";
  composition = pkgs.androidenv.composeAndroidPackages {
    cmdLineToolsVersion = commandLineToolsVersion;
    toolsVersion = "26.1.1";
    platformToolsVersion = "35.0.2";
    buildToolsVersions = [buildToolsVersion "35.0.0" "34.0.0"];
    platformVersions = ["35" "36"];
    includeSources = false;
    abiVersions = ["x86_64"];
    includeNDK = true;
    ndkVersions = [ndkVersion expoNdkVersion];
    cmakeVersions = ["3.22.1"];
    useGoogleAPIs = true;
    useGoogleTVAddOns = false;
  };
  sdk = composition.androidsdk;
  androidHome = "${sdk}/libexec/android-sdk";
  jdk = pkgs.jdk17;
  builder = pkgs.writeShellApplication {
    name = "build-t3code-android";
    runtimeInputs = with pkgs; [
      coreutils
      gawk
      gnused
      nix
    ];
    text =
      ''
        export T3CODE_SOURCE_TREE=${lib.escapeShellArg "${self}"}
        export T3CODE_ANDROID_FLAKE=${lib.escapeShellArg "${self}"}
        export T3CODE_SOURCE_REV=${lib.escapeShellArg (
          if buildCommit == ""
          then "local"
          else builtins.substring 0 8 buildCommit
        )}
      ''
      + builtins.readFile ./scripts/build-android-apk.sh;
  };
in {
  app = {
    type = "app";
    program = lib.getExe builder;
    meta.description = "Build a sideloadable Android APK from this checkout";
  };

  devShell = pkgs.mkShell {
    packages = with pkgs; [
      jdk
      sdk
      curl
      git
      gnumake
      nodejs_24
      pkg-config
      python3
      watchman
      xz
    ];

    ANDROID_HOME = androidHome;
    ANDROID_SDK_ROOT = androidHome;
    ANDROID_NDK_HOME = "${androidHome}/ndk/${ndkVersion}";
    ANDROID_NDK_ROOT = "${androidHome}/ndk/${ndkVersion}";
    JAVA_HOME = jdk.home;
    LC_ALL = "en_US.UTF-8";
    LANG = "en_US.UTF-8";
    GRADLE_OPTS = "-Dorg.gradle.project.android.aapt2FromMavenOverride=${androidHome}/build-tools/${buildToolsVersion}/aapt2";
    NODE_OPTIONS = "--max-old-space-size=8192";

    shellHook = ''
      export PATH="${androidHome}/platform-tools:${androidHome}/cmdline-tools/${commandLineToolsVersion}/bin:$PWD/node_modules/.bin:$PWD/apps/mobile/node_modules/.bin:$PATH"
      echo "T3 Code Android dev shell"
      echo "  node: $(node --version)"
      echo "  pnpm: $(corepack pnpm --version)"
      echo "  java: $(java -version 2>&1 | head -n 1)"
      echo "  sdk:  $ANDROID_SDK_ROOT"
      echo "  ndk:  $ANDROID_NDK_HOME"
    '';
  };
}
