#!/usr/bin/env bash
# Recompute nix/pnpm-deps.hash from the locked dependencies.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

log="$(mktemp)"
trap 'rm -f "$log"' EXIT

if nix build --no-link --print-build-logs .#pnpmDepsFakeHash 2>"$log"; then
  echo "pnpmDepsFakeHash unexpectedly built" >&2
  exit 1
fi

hash="$(grep -oP 'got:\s+\Ksha256-\S+' "$log" | tail -1 || true)"
if [[ -z "$hash" ]]; then
  cat "$log" >&2
  echo "could not find the pnpm dependency hash in the build output" >&2
  exit 1
fi

printf '%s\n' "$hash" > nix/pnpm-deps.hash
echo "$hash"
