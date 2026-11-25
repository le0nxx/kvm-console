#!/bin/sh
# Publish the current release into the share folder, one subdirectory per OS.
#
#   ./scripts/publish-share.sh [version] [dest]
#
# Defaults: version from package.json, dest /mnt/hxsj/Softwares-软件/KVM-Cosole
# Layout:   Windows/ + Linux/ + Docs/, with SHA256SUMS at the root.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
VERSION=${1:-$(node -p "require('$ROOT/package.json').version")}
DEST=${2:-/mnt/hxsj/Softwares-软件/KVM-Cosole}

PKG="kvm-console-${VERSION}-1-x86_64.pkg.tar.zst"
SETUP="KVM-Console-${VERSION}-win-x64-setup.exe"
PORTABLE="KVM-Console-${VERSION}-win-x64-portable.exe"
GUIDE_MD="KVM-Console-${VERSION}-User-Guide.md"
GUIDE_HTML="KVM-Console-${VERSION}-User-Guide.html"

for f in "$PKG" "$SETUP" "$PORTABLE"; do
  if [ ! -f "$ROOT/release/$f" ]; then
    echo "missing release/$f — build it first (see docs/WINDOWS-INSTALLER.md)" >&2
    exit 1
  fi
done

mkdir -p "$DEST/Windows" "$DEST/Linux" "$DEST/Docs"
cp -f "$ROOT/release/$SETUP" "$ROOT/release/$PORTABLE" "$DEST/Windows/"
cp -f "$ROOT/release/$PKG" "$DEST/Linux/"
[ -f "$ROOT/release/$GUIDE_MD" ] && cp -f "$ROOT/release/$GUIDE_MD" "$DEST/Docs/"
[ -f "$ROOT/release/$GUIDE_HTML" ] && cp -f "$ROOT/release/$GUIDE_HTML" "$DEST/Docs/"

# Checksums cover every file below the share root, using paths relative to it.
(cd "$DEST" && find . -type f ! -name 'SHA256SUMS*' -printf '%P\n' | sort | xargs -d '\n' sha256sum > SHA256SUMS)

echo "published $VERSION to $DEST"
find "$DEST" -maxdepth 2 -type f -printf '%P\n' | sort
