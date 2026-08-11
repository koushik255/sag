#!/bin/sh
set -eu

/usr/bin/open -na mpv --args \
    --idle=yes \
    --force-window=yes \
    --script-opts=stopandgo-open_on_start=yes
