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

# The check above is shallow by design, so a real mismatch confined to a
# deep path (buried inside some project's git worktree, say) would never
# get caught by it. Backfill that gap off the critical path instead of
# widening the startup check: once per PAPERCLIP_OWNERSHIP_AUDIT_INTERVAL_DAYS
# (default weekly), walk the whole tree in the background at the lowest
# scheduling priority and repair anything wrong. A marker file on the
# volume itself (not in-process state) tracks when it last ran, so this
# stays a cheap single stat() on every restart that isn't due -- the
# common case -- rather than re-running on a timer that resets whenever
# the pod does. Runs as root (before gosu drops privileges below) since
# repairing ownership needs it; exec later doesn't kill this -- it only
# replaces the calling shell, so the backgrounded subshell is reparented
# to tini and keeps running. The marker itself is written via `gosu node`
# rather than root + a follow-up chown: a root-owned marker sitting at the
# volume root would be exactly the kind of top-level mismatch the shallow
# startup probe above looks for, silently defeating its fast path (and, on
# a fully clean tree, tripping a chown on every single boot) from the very
# next restart on.
audit_marker="$home_dir/.ownership-audit-last-run"
audit_interval_days="${PAPERCLIP_OWNERSHIP_AUDIT_INTERVAL_DAYS:-7}"
(
    if [ -d "$home_dir" ]; then
        now=$(date +%s)
        last=0
        [ -f "$audit_marker" ] && last=$(cat "$audit_marker" 2>/dev/null || echo 0)
        case "$last" in ''|*[!0-9]*) last=0 ;; esac
        age_days=$(( (now - last) / 86400 ))
        if [ "$age_days" -ge "$audit_interval_days" ]; then
            # `|| true` is load-bearing. This script runs under `set -e`, and a bare
            # `var=$(cmd)` assignment propagates the command's exit status. `find`
            # exits 1 when it cannot read any single path -- a lost+found, a
            # directory left behind by another container -- even with stderr
            # discarded. Without this, the first unreadable path anywhere under
            # $home_dir kills this subshell before it logs, repairs, or writes the
            # marker, silently disabling the audit forever. A partial scan that
            # repairs what it can see is the correct outcome here; the whole point
            # of this block is to be the backstop that still runs.
            mismatches=$(nice -n 19 find "$home_dir" \( ! -user node -o ! -group node \) -print 2>/dev/null || true)
            if [ -n "$mismatches" ]; then
                echo "ownership-audit: mismatched paths found under $home_dir, repairing:" >&2
                echo "$mismatches" >&2
                nice -n 19 chown -R node:node "$home_dir"
            else
                echo "ownership-audit: full-tree scan of $home_dir clean, no mismatches" >&2
            fi
            gosu node sh -c 'date +%s > "$1"' _ "$audit_marker"
        fi
    fi
) &

exec gosu node "$@"
