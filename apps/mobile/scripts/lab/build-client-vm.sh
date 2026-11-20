# Builds the lab's dev client (T3 Code Dev, ad-hoc signed so secure storage works) in nick-vm.
# Run in the VM, in a checkout at ~/apps/conn-mobile-lab (rsync the worktree there first):
#   rsync -a --exclude node_modules --exclude .git --exclude '.t3*' --exclude '/apps/mobile/ios' ./ vm:apps/conn-mobile-lab/
#   scp apps/mobile/scripts/lab/build-client-vm.sh vm:apps/conn-mobile-lab-build.sh && ssh vm 'bash ~/apps/conn-mobile-lab-build.sh'
# Then copy .lab-derived/Build/Products/Debug-iphonesimulator/T3CodeDev.app to this Mac and
# `xcrun simctl install <udid> T3CodeDev.app`. Only needed again when native code changes.
set -e; trap "echo failed > ~/apps/conn-mobile-lab-build.rc" ERR
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 CI=1 EXPO_NO_GIT_STATUS=1
export PATH=/opt/homebrew/bin:$PATH
rm -f ~/apps/conn-mobile-lab-build.rc
cd ~/apps/conn-mobile-lab
exec > ~/apps/conn-mobile-lab-build.log 2>&1; echo started $(date)
pnpm install --frozen-lockfile --filter '@t3tools/mobile...' > .vm-install.log 2>&1 || { tail -30 .vm-install.log; exit 1; }
cd apps/mobile
export APP_VARIANT=development
npx expo prebuild --clean --platform ios --no-install > ../../.vm-prebuild.log 2>&1 || { tail -40 ../../.vm-prebuild.log; exit 1; }
(cd ios && pod install > ../../../.vm-pod.log 2>&1) || { tail -30 ../../.vm-pod.log; exit 1; }
xcodebuild -workspace ios/T3CodeDev.xcworkspace -scheme T3CodeDev -configuration Debug -destination 'generic/platform=iOS Simulator' -derivedDataPath ~/apps/conn-mobile-lab/.lab-derived ARCHS=arm64 ONLY_ACTIVE_ARCH=NO CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= PROVISIONING_PROFILE_SPECIFIER= build > ../../.vm-xcodebuild.log 2>&1 || { grep -E "error:|BUILD FAILED" ../../.vm-xcodebuild.log | head -40; exit 1; }
ls -d ~/apps/conn-mobile-lab/.lab-derived/Build/Products/Debug-iphonesimulator/*.app
echo BUILD_OK; echo done > ~/apps/conn-mobile-lab-build.rc
