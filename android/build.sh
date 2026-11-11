#!/bin/sh
# Build the signed release APK with the self-contained toolchain in ~/.local/android-toolchain.
# Gradle holds a couple of GB once it has run, so its daemon is stopped afterwards.
set -e
cd "$(dirname "$0")"
export JAVA_HOME="${JAVA_HOME:-$HOME/.local/android-toolchain/jdk17}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/.local/android-toolchain/sdk}"
gradle="${GRADLE:-$HOME/.local/android-toolchain/gradle/bin/gradle}"
status=0
"$gradle" -q testReleaseUnitTest assembleRelease "$@" || status=$?
"$gradle" -q --stop >/dev/null 2>&1 || true
[ "$status" = 0 ] || exit "$status"
ls -l app/build/outputs/apk/release/app-release.apk
