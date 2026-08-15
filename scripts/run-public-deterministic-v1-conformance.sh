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
  -u GH_TOKEN -u GITHUB_TOKEN -u OPENAI_API_KEY \
  bun --config=/dev/null --no-env-file "$runner" "$@"
