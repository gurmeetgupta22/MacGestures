#!/usr/bin/env bash

set -euo pipefail

UUID="macgesture@gurmeetgupta22"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$SCRIPT_DIR/$UUID"
INSTALL_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"

if [[ ! -d "$SOURCE_DIR" ]]; then
    printf 'Error: extension source directory not found: %s\n' "$SOURCE_DIR" >&2
    exit 1
fi

mkdir -p "$INSTALL_DIR"
cp -a "$SOURCE_DIR"/. "$INSTALL_DIR"/
glib-compile-schemas "$INSTALL_DIR/schemas"

printf 'Installed %s to %s\n' "$UUID" "$INSTALL_DIR"
printf '%s\n' 'On Wayland, log out and back in before enabling the extension.'
printf 'Then run: gnome-extensions enable %s\n' "$UUID"