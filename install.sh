#!/bin/sh
# Install lightcurve on this Linux computer. Run it as yourself; it never needs sudo.
#
#   ./install.sh --hub URL    track this computer and send to the hub at URL
#   ./install.sh              track this computer and keep the record here
#   ./install.sh --serve      run the hub here (the dashboard, and where every device sends to)
#   ./install.sh --serve --host 0.0.0.0 --port 4625
#
# --serve and tracking go together on one machine: ./install.sh --serve --hub http://127.0.0.1:4625
#
# Works straight from GitHub too, and running it again updates everything:
#   curl -fsSL https://raw.githubusercontent.com/ieatfood314/lightcurve/main/install.sh | sh -s -- --hub URL
set -eu

repo=https://github.com/ieatfood314/lightcurve

say() { printf '%s\n' "$*"; }
die() { printf 'lightcurve: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" != 0 ] || die "run this as yourself, not with sudo."

# Piped from curl there's no checkout around us: fetch one, then run the installer inside it.
here=$(cd "$(dirname "$0")" 2>/dev/null && pwd) || here=
if [ ! -f "$here/lightcurve/core.py" ]; then
    app="${XDG_DATA_HOME:-$HOME/.local/share}/lightcurve/app"
    say "Downloading lightcurve into $app"
    mkdir -p "$(dirname "$app")"
    if [ -d "$app/.git" ]; then
        git -C "$app" pull -q --ff-only
    elif [ ! -e "$app" ] && command -v git >/dev/null; then
        git clone -q --depth 1 "$repo.git" "$app"
    else
        tmp=$(mktemp -d)
        if command -v curl >/dev/null; then curl -fsSL "$repo/archive/refs/heads/main.tar.gz"
        else wget -qO- "$repo/archive/refs/heads/main.tar.gz"; fi | tar -xz -C "$tmp" --strip-components=1
        chmod 755 "$tmp"
        rm -rf "$app"
        mv "$tmp" "$app"
    fi
    exec sh "$app/install.sh" "$@"
fi

usage() {
    sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
}

hub= hub_given= serve= track=1 host=127.0.0.1 port=4625
while [ $# -gt 0 ]; do
    case $1 in
        --hub) [ $# -ge 2 ] || usage; hub=$2; hub_given=1; shift 2 ;;
        --serve) serve=1; shift ;;
        --host) [ $# -ge 2 ] || usage; host=$2; shift 2 ;;
        --port) [ $# -ge 2 ] || usage; port=$2; shift 2 ;;
        *) usage ;;
    esac
done
# A hub on its own doesn't track the machine it runs on unless asked to.
[ -z "$serve" ] || [ -n "$hub_given" ] || track=

[ "$(uname -s)" = Linux ] || die "the installer is for Linux."
command -v python3 >/dev/null || die "needs Python 3."
command -v systemctl >/dev/null || die "needs systemd to keep lightcurve running in the background."

units="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
bin="$HOME/.local/bin"
mkdir -p "$units" "$bin"
ln -sf "$here/bin/lightcurve" "$bin/lightcurve"

if [ -n "$serve" ]; then
    sed -e "s|@APP@|$here|g" -e "s|@HOST@|$host|g" -e "s|@PORT@|$port|g" \
        "$here/systemd/lightcurve.service" > "$units/lightcurve.service"
    systemctl --user daemon-reload
    systemctl --user enable -q lightcurve.service
    systemctl --user restart lightcurve.service
    say "The hub is running: http://$host:$port"
    say "It listens on this computer only unless you gave --host; put it on your tailnet or LAN for other devices."
fi

if [ -n "$track" ]; then
    python3 -c 'import dbus, gi' 2>/dev/null || die "the tracker needs python-dbus and python-gobject.
  Arch:   sudo pacman -S python-dbus python-gobject
  Debian: sudo apt install python3-dbus python3-gi
  Fedora: sudo dnf install python3-dbus python3-gobject
Then run this again."
    case "${XDG_CURRENT_DESKTOP:-}" in
        *KDE*) ;;
        *) say "Note: the tracker reads window focus from KWin, so it only records inside KDE Plasma." ;;
    esac
    if [ -n "$hub_given" ]; then
        "$here/bin/lightcurve" connect "$hub"
    fi
    sed -e "s|@APP@|$here|g" "$here/systemd/lightcurve-tracker.service" > "$units/lightcurve-tracker.service"
    systemctl --user daemon-reload
    systemctl --user enable -q lightcurve-tracker.service
    # waytime, which lightcurve replaces, would count the same time a second time.
    if systemctl --user is-enabled -q waytime.service 2>/dev/null || systemctl --user is-active -q waytime.service 2>/dev/null; then
        systemctl --user disable -q --now waytime.service 2>/dev/null || true
        say "Stopped waytime (its history is brought over as daily totals; nothing of its was deleted)."
    fi
    systemctl --user restart lightcurve-tracker.service
    say "Tracking this computer. See what it's doing with: lightcurve status"
fi

case ":$PATH:" in
    *":$bin:"*) ;;
    *) say "Add $bin to your PATH to use the lightcurve command." ;;
esac
say "Done. Update any time with: $here/update.sh"
