#!/usr/bin/env bash
# install.sh — MacGesture GNOME Shell Extension installer
# GitHub: https://github.com/gurmeetgupta22/MacGesture
#
# Usage: bash install.sh [--uninstall]
#
# On Wayland you MUST log out and back in after installing so GNOME Shell
# reloads extensions from disk.  After re-login, run:
#   gnome-extensions enable macgesture@gurmeetgupta22

set -euo pipefail

UUID="macgesture@gurmeetgupta22"
OLD_UUID="macgesture@gurmeet-gupta"   # legacy name — will be removed if present
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$SCRIPT_DIR/$UUID"
INSTALL_BASE="$HOME/.local/share/gnome-shell/extensions"
INSTALL_DIR="$INSTALL_BASE/$UUID"
OLD_INSTALL_DIR="$INSTALL_BASE/$OLD_UUID"

# ── helpers ──────────────────────────────────────────────────────────────────

log()  { printf '\033[1;32m[MacGesture]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[MacGesture]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[MacGesture]\033[0m %s\n' "$*" >&2; exit 1; }

disable_if_active() {
    local uuid="$1"
    if gnome-extensions info "$uuid" &>/dev/null 2>&1; then
        gnome-extensions disable "$uuid" 2>/dev/null && \
            warn "Disabled existing extension: $uuid" || true
    fi
}

# ── uninstall mode ────────────────────────────────────────────────────────────

if [[ "${1:-}" == "--uninstall" ]]; then
    log "Uninstalling $UUID …"
    disable_if_active "$UUID"
    disable_if_active "$OLD_UUID"

    rm -rf "$INSTALL_DIR"
    [[ -d "$OLD_INSTALL_DIR" ]] && rm -rf "$OLD_INSTALL_DIR" && warn "Removed legacy $OLD_UUID"
    log "Done. Log out and back in to fully unload the extension."
    exit 0
fi

# ── sanity checks ─────────────────────────────────────────────────────────────

[[ -d "$SOURCE_DIR" ]] || \
    err "Source directory not found: $SOURCE_DIR\nRun this script from the MacGesture repository root."

[[ -f "$SOURCE_DIR/metadata.json" ]] || \
    err "metadata.json missing in $SOURCE_DIR"

[[ -f "$SOURCE_DIR/extension.js" ]] || \
    err "extension.js missing in $SOURCE_DIR"

[[ -f "$SOURCE_DIR/schemas/org.gnome.shell.extensions.macgesture.gschema.xml" ]] || \
    err "GSettings schema XML missing in $SOURCE_DIR/schemas/"

# Check glib-compile-schemas is available
command -v glib-compile-schemas &>/dev/null || \
    err "'glib-compile-schemas' not found. Install it with: sudo apt install libglib2.0-dev-bin"

# ── remove legacy extension if present ───────────────────────────────────────

if [[ -d "$OLD_INSTALL_DIR" ]]; then
    warn "Found legacy extension at $OLD_INSTALL_DIR — removing it to avoid conflicts."
    disable_if_active "$OLD_UUID"
    rm -rf "$OLD_INSTALL_DIR"
    log "Removed $OLD_UUID"
fi

# ── install ───────────────────────────────────────────────────────────────────

log "Installing $UUID …"
mkdir -p "$INSTALL_DIR"

# Copy all extension files, excluding any stray .zip or .git artefacts
rsync -a --delete \
    --exclude='*.zip' \
    --exclude='.git' \
    --exclude='.gitignore' \
    "$SOURCE_DIR/" "$INSTALL_DIR/" 2>/dev/null \
  || cp -a "$SOURCE_DIR/." "$INSTALL_DIR/"

# (Re-)compile schemas inside the installed copy
glib-compile-schemas "$INSTALL_DIR/schemas/"
log "GSettings schema compiled."

# ── enable ────────────────────────────────────────────────────────────────────

SHELL_VERSION=$(gnome-shell --version 2>/dev/null | grep -oP '\d+' | head -1)
log "Detected GNOME Shell $SHELL_VERSION"

# Try to enable immediately (works in X11 or if already in a live session).
# On Wayland the extension list is only refreshed after login, so we just
# print a reminder if enabling fails.
if gnome-extensions enable "$UUID" 2>/dev/null; then
    log "Extension enabled successfully."
else
    warn "Could not enable extension right now (normal on Wayland)."
    printf '\n'
    printf '  ┌─────────────────────────────────────────────────────────────┐\n'
    printf '  │  Log out and log back in, then run:                         │\n'
    printf '  │    gnome-extensions enable %s   │\n' "$UUID"
    printf '  └─────────────────────────────────────────────────────────────┘\n'
    printf '\n'
fi

log "Installed to: $INSTALL_DIR"
log "Open Settings → Extensions → MacGesture to configure."
