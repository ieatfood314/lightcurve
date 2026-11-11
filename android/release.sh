#!/bin/sh
# Build the APK from the current commit and publish it as a GitHub release (what Obtainium picks up).
# The version is <lightcurveVersion>.<commit count>, so commit first; a dirty tree is refused.
set -e
cd "$(dirname "$0")"
[ -z "$(git status --porcelain)" ] || { echo "Commit your changes first: the version comes from the commit count." >&2; exit 1; }
git fetch -q origin
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "Push first: the release tag has to point at a commit GitHub has." >&2; exit 1; }
version="$(sed -n 's/^lightcurveVersion=//p' gradle.properties).$(git rev-list --count HEAD)"
./build.sh
out="build/lightcurve-$version.apk"
mkdir -p build
cp app/build/outputs/apk/release/app-release.apk "$out"
gh release create "v$version" "$out" --title "lightcurve $version" --notes "${1:-Android app $version.}"
echo "Released v$version"
