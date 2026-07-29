#!/usr/bin/env bash

set -e
if [ "${HERDR_ENV:-}" != 1 ] || [ -z "${HERDR_PANE_ID:-}" ]; then
  echo "herdr-nvim.sh must run inside herdr" >&2
  exit 1
fi

if [ "$#" -ne 1 ]; then
  echo "usage: $0 PATH" >&2
  exit 2
fi

# split the calling pane so the review lands in its tab/workspace, not the focused one
NEW_PANE=$(herdr pane split "$HERDR_PANE_ID" --direction right | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])')
FILE=$(printf '%q' "$1")
BEFORE=$(mktemp)
trap 'rm -f "$BEFORE"' EXIT
cp -- "$1" "$BEFORE" 2>/dev/null || : # absent file: diff against empty
herdr pane run "$NEW_PANE" "nvim $FILE; printf '%s\\n' __NVIM_\"CLOSED__\"" >/dev/null
herdr pane wait-output "$NEW_PANE" --match "__NVIM_CLOSED__" --timeout 3600000 >/dev/null
herdr pane close "$NEW_PANE" >/dev/null

# report the operator's edits to the caller; diff exits 1 when they differ
if diff -u --label "$1 (before)" --label "$1 (after)" -- "$BEFORE" "$1"; then
  echo "unchanged by operator: $1"
fi
