#!/usr/bin/env bash
# Сборка Mantis Агента для macOS (Apple Silicon и Intel) и Windows.
#   bash agent/build.sh                 — все платформы
#   bash agent/build.sh darwin-arm64    — одна
# Нужно: Node (для npm run build), Bun ≥ 1.4 (BUN=путь, иначе bun из PATH),
# для подписи macOS-приложения без Mac — rcodesign (RCODESIGN=путь); на Mac используется codesign.
# Результат: agent/dist/Mantis-Agent-*.zip
set -euo pipefail
cd "$(dirname "$0")/.."

# Bun: из переменной BUN, из PATH или из node_modules (ставится с npm install)
BUN="${BUN:-$(command -v bun || echo node_modules/.bin/bun)}"
RCODESIGN="${RCODESIGN:-rcodesign}"
FFMPEG_RELEASE="b6.1.1"            # тот же ffmpeg, что ставит пакет ffmpeg-static
VERSION="$(node -p "require('./package.json').version")"
TARGETS=("${@:-darwin-arm64 darwin-x64 windows-x64}")
TARGETS=(${TARGETS[@]})
OUT="agent/dist"
CACHE="agent/.cache"
mkdir -p "$OUT" "$CACHE" agent/build

echo "== Сборка страницы"
npm run build --silent
node agent/pack.mjs dist agent/build/assets.bin

ffmpeg_for() { # $1 = darwin-arm64 | darwin-x64 | win32-x64 | linux-x64
  local f="$CACHE/ffmpeg-$1"
  if [ ! -s "$f" ]; then
    echo "   скачиваю ffmpeg для $1" >&2
    curl -fsSL "https://github.com/eugeneware/ffmpeg-static/releases/download/$FFMPEG_RELEASE/ffmpeg-$1.gz" | gunzip > "$f"
  fi
  echo "$f"
}

sign_mac() { # $1 = путь к .app
  if command -v codesign >/dev/null 2>&1 && [ "$(uname)" = "Darwin" ]; then
    if [ -n "${MAC_SIGN_ID:-}" ]; then
      # Developer ID + hardened runtime (нужно для заверения у Apple). Bun использует JIT — нужны разрешения.
      cat > "$CACHE/entitlements.plist" <<'ENT'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-executable-page-protection</key><true/>
  <key>com.apple.security.cs.allow-dyld-environment-variables</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict></plist>
ENT
      codesign --force --deep --options runtime --entitlements "$CACHE/entitlements.plist" --timestamp --sign "$MAC_SIGN_ID" "$1"
    else
      codesign --force --deep --sign - "$1"
    fi
  elif command -v "$RCODESIGN" >/dev/null 2>&1 || [ -x "$RCODESIGN" ]; then
    "$RCODESIGN" sign "$1" >/dev/null
  else
    echo "   (!) нет codesign/rcodesign — приложение без подписи не запустится на Apple Silicon"
  fi
}

for t in "${TARGETS[@]}"; do
  echo "== $t"
  case "$t" in
    darwin-arm64) bt="bun-darwin-arm64"; ff="darwin-arm64" ;;
    darwin-x64)   bt="bun-darwin-x64";   ff="darwin-x64" ;;
    windows-x64)  bt="bun-windows-x64";  ff="win32-x64" ;;
    linux-x64)    bt="bun-linux-x64";    ff="linux-x64" ;;
    *) echo "неизвестная платформа $t"; exit 1 ;;
  esac
  cp "$(ffmpeg_for "$ff")" agent/build/ffmpeg.bin
  work="$CACHE/$t"
  rm -rf "$work" && mkdir -p "$work"
  extra=()
  [ "$t" = "windows-x64" ] && extra=(--windows-hide-console)
  "$BUN" build agent/agent.ts --compile --minify --target="$bt" --loader .bin:file ${extra[@]+"${extra[@]}"} --outfile "$work/mantis-agent" >/dev/null

  case "$t" in
    darwin-*)
      app="$work/Mantis Agent.app"
      mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
      mv "$work/mantis-agent" "$app/Contents/MacOS/mantis-agent"
      cp agent/assets/AppIcon.icns "$app/Contents/Resources/AppIcon.icns"
      cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Mantis Agent</string>
  <key>CFBundleDisplayName</key><string>Mantis Агент</string>
  <key>CFBundleIdentifier</key><string>ru.rsmit.mantis-agent</string>
  <key>CFBundleExecutable</key><string>mantis-agent</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><true/>
  <key>NSLocalNetworkUsageDescription</key><string>Mantis ищет IP-камеры в сети магазина и получает с них видео для подсчёта посетителей.</string>
</dict></plist>
PLIST
      sign_mac "$app"
      cp agent/README-agent.txt "$work/Как запустить.txt"
      (cd "$work" && rm -f "../../dist/Mantis-Agent-macOS-${t#darwin-}.zip" && zip -qry "../../dist/Mantis-Agent-macOS-${t#darwin-}.zip" "Mantis Agent.app" "Как запустить.txt")
      ;;
    windows-x64)
      mv "$work/mantis-agent.exe" "$work/Mantis Agent.exe"
      cp agent/README-agent.txt "$work/Как запустить.txt"
      (cd "$work" && rm -f ../../dist/Mantis-Agent-Windows.zip && zip -qr ../../dist/Mantis-Agent-Windows.zip "Mantis Agent.exe" "Как запустить.txt")
      ;;
    linux-x64)
      mv "$work/mantis-agent" "$OUT/mantis-agent-linux-x64"
      ;;
  esac
done
rm -f agent/build/ffmpeg.bin
ls -lh "$OUT"
