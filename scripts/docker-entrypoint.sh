#!/bin/sh
set -e

# Capture runtime UID/GID from environment variables, defaulting to 1000
PUID=${USER_UID:-1000}
PGID=${USER_GID:-1000}

# Without root we can neither remap the node user (usermod/groupmod/chown)
# nor switch users (gosu needs CAP_SETUID/CAP_SETGID), so exec directly.
# This covers Kubernetes restricted PodSecurity (runAsNonRoot + runAsUser)
# as well as platforms that assign arbitrary UIDs (e.g. OpenShift); for the
# latter a UID/GID mismatch is unfixable here, so warn instead of letting
# usermod fail cryptically and keep volume-permission issues diagnosable.
if [ "$(id -u)" -ne 0 ]; then
    if [ "$(id -u)" -ne "$PUID" ] || [ "$(id -g)" -ne "$PGID" ]; then
        echo "docker-entrypoint.sh: running unprivileged as $(id -u):$(id -g); cannot remap to requested ${PUID}:${PGID}" >&2
    fi
    exec "$@"
fi

# Adjust the node user's UID/GID if they differ from the runtime request
if [ "$(id -u node)" -ne "$PUID" ]; then
    echo "Updating node UID to $PUID"
    usermod -o -u "$PUID" node
fi

if [ "$(id -g node)" -ne "$PGID" ]; then
    echo "Updating node GID to $PGID"
    groupmod -o -g "$PGID" node
    usermod -g "$PGID" node
fi

# Ensure the app home is owned by the runtime user BEFORE dropping
# privileges -- not only after a UID/GID remap. A freshly mounted volume
# (Docker named volume, Railway volume, Kubernetes PV) arrives root-owned
# and shadows the image's build-time chown, so with the default UID the old
# remap-only condition dropped privileges onto an unwritable home and the
# server crashed on its first mkdir.
#
# The probe used to be a first-mismatch find over the WHOLE tree. That is
# correct but not scoped to the failure mode it exists for: a fresh mount,
# a backup restore, or an init container all land wrong ownership at (or
# near) the volume root, not several million inodes deep inside a single
# leaf directory. On a long-lived PVC that accumulates per-project working
# trees (each with its own node_modules), the full walk costs 20-60+
# minutes of nothing-found metadata reads on every single restart -- see
# home-lab#(paperclip disk incident, 2026-08-30) for a walk that ran past
# an hour on a ~2.3M-inode volume. That's the same shape of problem
# home-lab#287 already fixed on the kubelet side: fsGroupChangePolicy:
# OnRootMismatch stopped kubelet's own recursive chown by trusting the
# mount root's ownership as a proxy for the whole volume. This mirrors
# that same trade-off at the application layer: check the root and its
# immediate children (cheap, bounded by the number of top-level entries,
# not by tree depth) rather than walking every leaf. A mismatch confined
# to a deeply nested path with an otherwise-correct root/children would
# no longer be caught here -- accepted, because every mismatch we've
# actually hit (fresh mount, restore, remap) has shown up at this depth,
# and a real deep-tree miss surfaces as a diagnosable EACCES at runtime
# rather than a silent multi-hour boot.
home_dir="${PAPERCLIP_HOME:-/paperclip}"
if [ -d "$home_dir" ] && [ -n "$(find "$home_dir" -maxdepth 1 \( ! -user node -o ! -group node \) -print -quit 2>/dev/null)" ]; then
    chown -R node:node "$home_dir"
fi

exec gosu node "$@"
