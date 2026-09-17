#!/usr/bin/env bash
# Capture a short walkthrough of the live app as PNG frames and stitch them
# into docs/demo.gif.
#
# Requirements:
#   - gstack "browse" headless browser binary
#     (default: ~/.codex/skills/gstack/browse/dist/browse; override with $BROWSE)
#   - ffmpeg on PATH
#
# Usage:
#   scripts/capture-demo.sh                      # capture + stitch against the live site
#   APP_URL=http://localhost:5173 scripts/capture-demo.sh
#   ACCOUNT_NAME="Mr Smith Main" AFFORDABLE_AMOUNT=2500 RISKY_AMOUNT=40000 scripts/capture-demo.sh
#   SKIP_CAPTURE=1 scripts/capture-demo.sh       # only re-stitch existing frames
#
# Frames are written to docs/demo-frames/NN-label.png (viewport 1280x800) and
# the GIF plays at ~1 fps. Result frames are duplicated so they stay on screen
# a little longer. Frame order is the storyline:
#   landing -> open account picker -> switch account -> affordability form
#   -> affordable result -> risky result -> recurring payments table -> footer
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRAMES_DIR="$ROOT/docs/demo-frames"
GIF_OUT="$ROOT/docs/demo.gif"

APP_URL="${APP_URL:-https://investec-future-you.vercel.app}"
ACCOUNT_NAME="${ACCOUNT_NAME:-Mr Smith Main}"
AFFORDABLE_LABEL="${AFFORDABLE_LABEL:-Weekend away}"
AFFORDABLE_AMOUNT="${AFFORDABLE_AMOUNT:-2500}"
RISKY_LABEL="${RISKY_LABEL:-New laptop}"
RISKY_AMOUNT="${RISKY_AMOUNT:-40000}"
VIEWPORT="${VIEWPORT:-1280x800}"
SETTLE="${SETTLE:-2}" # seconds to wait for Convex queries / animations
B="${BROWSE:-$HOME/.codex/skills/gstack/browse/dist/browse}"

log() { printf '\033[1;32m[capture]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[capture] %s\033[0m\n' "$*" >&2; exit 1; }

frame_no=0
# frame <label> [copies]  -> saves the current viewport as the next frame(s)
frame() {
  local label="$1" copies="${2:-1}" i
  for ((i = 0; i < copies; i++)); do
    frame_no=$((frame_no + 1))
    local path
    path="$(printf '%s/%02d-%s.png' "$FRAMES_DIR" "$frame_no" "$label")"
    "$B" screenshot --viewport "$path" >/dev/null
    log "frame $frame_no: $label"
  done
}

# scroll_to_heading <regex> -> scroll the card whose title matches into view
scroll_to_heading() {
  "$B" js "(() => { const h = [...document.querySelectorAll('h1,h2,h3,h4,[data-slot=card-title]')].find(e => /$1/i.test(e.textContent || '')); if (!h) return false; (h.closest('[data-slot=card]') || h).scrollIntoView({block: 'start'}); window.scrollBy(0, -24); return true; })()" >/dev/null
}

# ref_of <grep pattern> -> first @eN ref whose snapshot line matches
ref_of() {
  local pattern="$1" ref
  ref="$("$B" snapshot -i 2>/dev/null | grep -F -- "$pattern" | grep -o '@e[0-9]*' | head -1 || true)"
  [ -n "$ref" ] || die "Could not find an element matching: $pattern"
  printf '%s' "$ref"
}

capture() {
  [ -x "$B" ] || die "browse binary not found/executable at $B (set BROWSE=...)"
  rm -rf "$FRAMES_DIR"
  mkdir -p "$FRAMES_DIR"

  log "opening $APP_URL"
  "$B" viewport "$VIEWPORT" >/dev/null
  "$B" goto "$APP_URL" >/dev/null
  sleep $((SETTLE + 2))
  frame landing

  log "switching account to: $ACCOUNT_NAME"
  "$B" click "$(ref_of '[combobox]')" >/dev/null
  sleep 1
  frame account-picker-open
  "$B" click "$(ref_of "$ACCOUNT_NAME")" >/dev/null
  sleep "$SETTLE"
  frame account-switched

  log "affordability check (affordable): $AFFORDABLE_LABEL R$AFFORDABLE_AMOUNT"
  scroll_to_heading 'afford'
  sleep 1
  "$B" fill "$(ref_of '[textbox] "New TV"')" "$AFFORDABLE_LABEL" >/dev/null
  "$B" fill "$(ref_of '[spinbutton]')" "$AFFORDABLE_AMOUNT" >/dev/null
  frame affordability-form
  "$B" click "$(ref_of '[button] "Check"')" >/dev/null
  sleep "$SETTLE"
  frame affordability-yes 2

  log "affordability check (risky): $RISKY_LABEL R$RISKY_AMOUNT"
  "$B" fill "$(ref_of '[textbox] "New TV"')" "$RISKY_LABEL" >/dev/null
  "$B" fill "$(ref_of '[spinbutton]')" "$RISKY_AMOUNT" >/dev/null
  "$B" click "$(ref_of '[button] "Check"')" >/dev/null
  sleep "$SETTLE"
  frame affordability-risky 2

  log "recurring payments table"
  scroll_to_heading 'recurring|upcoming'
  sleep 1
  frame recurring-table 2
  "$B" scroll >/dev/null # page bottom: rest of the table + disclaimer footer
  sleep 1
  frame footer-disclaimer
}

stitch() {
  command -v ffmpeg >/dev/null || die "ffmpeg not found on PATH"
  local count
  count="$(find "$FRAMES_DIR" -name '*.png' | wc -l | tr -d ' ')"
  [ "$count" -gt 0 ] || die "no frames in $FRAMES_DIR"
  log "stitching $count frames -> $GIF_OUT"
  ffmpeg -hide_banner -loglevel error -y \
    -framerate 1 -pattern_type glob -i "$FRAMES_DIR/*.png" \
    -vf 'fps=1,scale=1000:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle' \
    -loop 0 "$GIF_OUT"
  log "done: $(du -h "$GIF_OUT" | cut -f1) $GIF_OUT"
}

if [ "${SKIP_CAPTURE:-0}" != "1" ]; then
  capture
fi
stitch
