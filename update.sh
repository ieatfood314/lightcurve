#!/bin/sh
# Bring this install up to date and restart whatever is running from it.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
if [ -d "$here/.git" ]; then
    git -C "$here" pull -q --ff-only
else
    tmp=$(mktemp -d)
    curl -fsSL https://github.com/ieatfood314/lightcurve/archive/refs/heads/main.tar.gz | tar -xz -C "$tmp" --strip-components=1
    cp -a "$tmp/." "$here/"
    rm -rf "$tmp"
fi
for unit in lightcurve.service lightcurve-tracker.service; do
    if systemctl --user is-enabled -q "$unit" 2>/dev/null; then
        systemctl --user restart "$unit" || true
        echo "Restarted $unit"
    fi
done
echo "lightcurve $("$here/bin/lightcurve" version)"
