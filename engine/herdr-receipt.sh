#!/bin/bash

[[ -z "${HERDR_RECEIPT_LOADED:-}" ]] || return 0
HERDR_RECEIPT_LOADED=1

# Compatibility entry: preserve the complete sourced API for existing callers.
herdr_library_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$herdr_library_dir/herdr-engine-common.sh"
source "$herdr_library_dir/herdr-receipt-store.sh"
source "$herdr_library_dir/herdr-native-identity.sh"
source "$herdr_library_dir/herdr-prompt-delivery.sh"
