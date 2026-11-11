#!/usr/bin/env bash
# Builds the Windows host and assembles a runnable folder.
#
#   scripts/package-windows.sh [installer.exe]
#
# The installer argument is optional: when omitted, the script looks for
# ZaloSetup-<version>.exe in $OLAZ_INSTALLER, the repository root, or the data
# directory. Without an installer the app still runs if the runtime was already
# installed in %LOCALAPPDATA%\Olaz\ZaloRuntime.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
export PATH="${HOME}/.cargo/bin:${HOME}/.local/bin:${PATH}"

target=x86_64-pc-windows-gnu
version="$(sed -n 's/^pub const RUNTIME_VERSION: &str = "\(.*\)";/\1/p' crates/olaz-core/src/runtime/release.rs)"
dist="$root/dist/olaz-$version"

cargo build -p olaz-app --target "$target" --release

rm -rf "$dist"
mkdir -p "$dist"

cp "target/$target/release/olaz-app.exe" "$dist/Olaz.exe"
cp resources/WebView2Loader.dll "$dist/WebView2Loader.dll"

installer="${1:-${OLAZ_INSTALLER:-}}"
if [[ -z "$installer" ]]; then
  for candidate in "$root/ZaloSetup-$version.exe" "${HOME}/.local/share/olaz/ZaloSetup-$version.exe"; do
    if [[ -f "$candidate" ]]; then installer="$candidate"; break; fi
  done
fi
if [[ -n "$installer" ]]; then
  cp "$installer" "$dist/"
else
  echo "warning: no ZaloSetup-$version.exe packaged; the runtime must already be installed" >&2
fi

cat > "$dist/README.txt" <<'EOF'
Olaz — Zalo cho Windows
=======================

Chạy Olaz.exe. Lần đầu, chương trình sẽ giải nén runtime Zalo chính thức
(ZaloSetup-26.11.11.exe đặt cùng thư mục) vào:
    %LOCALAPPDATA%\Olaz\ZaloRuntime

Yêu cầu: Microsoft Edge WebView2 Runtime (có sẵn trên Windows 11).
Dữ liệu đăng nhập nằm trong %LOCALAPPDATA%\Olaz.
EOF

echo "package: $dist"
ls -lh "$dist"
