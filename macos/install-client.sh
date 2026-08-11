#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(dirname "$script_dir")
mpv_config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/mpv"
scripts_dir="$mpv_config_dir/scripts"
options_dir="$mpv_config_dir/script-opts"
launcher_app="$HOME/Applications/MPV Library.app"

mkdir -p "$scripts_dir" "$options_dir"
install -m 0644 "$project_dir/client/stopandgo.lua" "$scripts_dir/stopandgo.lua"
install -m 0644 "$project_dir/client/clip-last.lua" "$scripts_dir/clip-last.lua"
chmod +x "$project_dir/macos/open-library.command"

if [ ! -e "$options_dir/stopandgo.conf" ]; then
    install -m 0644 "$project_dir/config/stopandgo.conf.example" "$options_dir/stopandgo.conf"
    echo "Created $options_dir/stopandgo.conf; edit api_url before opening mpv."
else
    echo "Kept existing $options_dir/stopandgo.conf."
fi

if [ ! -e "$options_dir/clip-last.conf" ]; then
    install -m 0644 "$project_dir/config/clip-last.conf.example" "$options_dir/clip-last.conf"
fi

mkdir -p "$launcher_app/Contents/MacOS" "$launcher_app/Contents/Resources"
install -m 0644 "$project_dir/macos/app-template/Info.plist" "$launcher_app/Contents/Info.plist"
install -m 0755 "$project_dir/macos/app-template/MPVLibrary" "$launcher_app/Contents/MacOS/MPVLibrary"
if [ -f "$HOME/Applications/mpv.app/Contents/Resources/icon.icns" ]; then
    install -m 0644 "$HOME/Applications/mpv.app/Contents/Resources/icon.icns" "$launcher_app/Contents/Resources/icon.icns"
elif [ -f "/Applications/mpv.app/Contents/Resources/icon.icns" ]; then
    install -m 0644 "/Applications/mpv.app/Contents/Resources/icon.icns" "$launcher_app/Contents/Resources/icon.icns"
fi

launch_services="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [ -x "$launch_services" ]; then
    "$launch_services" -f "$launcher_app"
fi
if [ -x /usr/bin/mdimport ]; then
    /usr/bin/mdimport "$launcher_app" >/dev/null 2>&1 || true
fi

echo "Installed StopAndGo. Ctrl+b opens movies; 5 clips; s saves a server screenshot."
echo "You can also double-click $project_dir/macos/open-library.command."
echo "MPV Library.app is installed for Spotlight and Raycast."
