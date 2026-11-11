#!/bin/sh
# Stop lightcurve on this computer. Your record stays where it is unless you pass --delete-data.
set -eu
units="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
for unit in lightcurve.service lightcurve-tracker.service; do
    if [ -f "$units/$unit" ]; then
        systemctl --user disable -q --now "$unit" 2>/dev/null || true
        rm -f "$units/$unit"
    fi
done
systemctl --user daemon-reload
rm -f "$HOME/.local/bin/lightcurve"
data="${XDG_DATA_HOME:-$HOME/.local/share}/lightcurve"
if [ "${1:-}" = "--delete-data" ]; then
    rm -rf "$data" "${XDG_CONFIG_HOME:-$HOME/.config}/lightcurve"
    echo "lightcurve and its record are gone from this computer."
else
    echo "lightcurve is stopped. Its record is still in $data (pass --delete-data to remove that too)."
fi
