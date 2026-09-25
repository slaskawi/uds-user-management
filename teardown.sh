#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
test -f .local/cluster-owner || { echo 'No cluster owned by this setup.' >&2; exit 1; }
export KUBECONFIG="$PWD/.local/kubeconfig"
# This exact local cluster and its volumes are disposable. Never delete all clusters.
k3d cluster delete uds-user-management
rm -f .local/core-ready .local/cluster-owner .local/admin-credentials .local/kubeconfig
echo 'Deleted uds-user-management and its cluster data. Cluster data cannot be recovered.'
