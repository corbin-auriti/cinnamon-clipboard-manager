#!/bin/bash
#
# Installs the applet from ./applet into the user's Cinnamon xlet directory
# and reloads it in the running session.  Safe to run repeatedly; the running
# applet keeps its settings and instance id across reloads.
#
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)/applet"
DEST="$HOME/.local/share/cinnamon/applets/clipboard-manager@ravetcofx"

mkdir -p "$DEST"
cp -f "$SRC"/* "$DEST"/

gdbus call --session \
    --dest org.Cinnamon.LookingGlass \
    --object-path /org/Cinnamon/LookingGlass \
    --method org.Cinnamon.LookingGlass.Eval \
    "imports.ui.extension.reloadExtension('clipboard-manager@ravetcofx', imports.ui.extension.Type.APPLET)" \
    >/dev/null 2>&1 \
    && echo "Reloaded in the running session." \
    || echo "Not reloaded (no Cinnamon session on this bus). Log out and back in, or toggle the applet in System Settings > Applets."

echo "Installed to $DEST"
