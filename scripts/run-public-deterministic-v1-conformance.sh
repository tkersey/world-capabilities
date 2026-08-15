#!/bin/sh
set -eu

if [ "${BUN_OPTIONS+x}" = x ] || [ "${NODE_OPTIONS+x}" = x ]; then
  echo "BUN_OPTIONS and NODE_OPTIONS must be unset for deterministic conformance" >&2
  exit 1
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
runner="$script_dir/run-conformance.mjs"
if [ ! -f "$runner" ]; then
  runner="$script_dir/run-public-deterministic-v1-conformance.mjs"
fi
WORLD_CAPABILITIES_CONFORMANCE_WRAPPER=1 exec env -u BUN_OPTIONS -u NODE_OPTIONS \
  bun --config=/dev/null "$runner" "$@"
