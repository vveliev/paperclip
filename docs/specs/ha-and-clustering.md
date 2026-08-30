# Paperclip High Availability and Clustering

Status: Draft v0 (problem statement + evidence, design not yet decided)

Purpose: Establish what "high availability" and "clustering" would actually mean for a
self-hosted Paperclip instance, grounded in a real incident rather than in the abstract, and lay
out a phased path from today's single-instance deployment toward something more resilient.

## 1. Problem Statement

Paperclip today runs as exactly one pod, backed by exactly one `ReadWriteOnce` volume that holds
every company's execution workspaces (git worktrees, `node_modules`, checkouts) alongside the
app's own scratch state. There is no redundancy at the compute layer and no horizontal scaling
path. On 2026-08-30, this surfaced concretely:

- The volume (`paperclip-data-lh`, Longhorn-backed) filled to 100% (60Gi/60Gi), taking the whole
  instance down. Root cause: per-issue git worktrees accumulate indefinitely — see §3.
- Expanding the volume (60Gi → 120Gi, a routine online Longhorn resize) forced a pod restart, which
  in turn triggered a startup ownership-verification `find` over the entire tree. On a
  ~2.3M-inode volume, that walk took 20-60+ minutes, got killed mid-scan twice by the liveness
  probe (each kill discarding all progress and restarting the walk from zero), and only completed
  once the probe's `initialDelaySeconds` was raised to survive it.
- A second, unrelated restart (a probe-config patch applied while the pod was still mid-scan)
  cost another ~45 minutes for no benefit, because *any* change to the pod spec triggers a full
  replacement under `Recreate` strategy, and the replacement pod pays the same walk cost again.

None of this is a bug in the narrow sense — every individual piece of behavior (the ownership
check, the `Recreate` strategy, the RWO volume, the workspace-cooldown reaper) is defensible in
isolation. The incident exposed what happens when they compound: a single instance with no
redundancy means every one of these costs is paid serially, on the critical path, with the whole
product down while it happens.

## 2. Goals and Non-Goals

### 2.1 Goals

- Define what failure modes this effort is meant to survive: a slow/expensive restart (today's
  incident), a node failure, a storage failure, and (stretch) planned maintenance without downtime.
- Capture the concrete architectural constraints discovered today that any HA/clustering design
  has to either work within or explicitly change.
- Lay out an incremental path — cheap wins that reduce blast radius now, up through what real
  multi-instance clustering would require — rather than a single big-bang redesign.

### 2.2 Non-Goals (for this draft)

- This document does not commit to building full active-active clustering. §5 states plainly that
  it is a large, multi-phase undertaking and scopes what a first phase would realistically cover.
- Not scoped here: multi-region/multi-cluster deployment, or supporting a company's execution
  workspaces being sharded across untrusted third-party infrastructure.

## 3. Current Architecture and Constraints (evidence from today)

### 3.1 Storage is single-writer by construction

`paperclip-data-lh` is a Longhorn volume with `accessModes: [ReadWriteOnce]`. Only one node can
mount it at a time. The Deployment's `strategy.type` is `Recreate`, not `RollingUpdate` — this is
not an oversight, it is required: a second pod cannot attach the same RWO volume while the first
still holds it, so any rolling update would deadlock. Concretely this means:

- Zero-downtime deploys are impossible today. Every deploy is old-pod-terminates-first,
  new-pod-attaches-second, however long that takes.
- There is exactly one copy of live execution-workspace state at the application layer (Longhorn
  itself replicates underneath — see §3.5 — but the app only ever sees one mount).

### 3.2 Application state assumes a single process

Grepping `server/src` for multi-instance handling found:

- `app.ts`: an explicit comment that company-transfer "apply jobs are in-memory in this single
  process," with a startup-only DB sweep to recover jobs a previous process was mid-way through
  when it was killed. This is a single-instance recovery pattern (detect-and-resume after the fact),
  not a coordination pattern (no in-flight job is ever visible to, or resumable by, another
  process while the original one is still alive).
- `plugin-job-scheduler.ts`: one comment — "also check DB for running runs (defensive — covers
  multi-instance)" — suggesting *some* awareness that a second instance could theoretically exist,
  but this reads as defensive coding, not a supported or tested topology. No leader-election,
  distributed lock, or instance-registry mechanism was found anywhere in the codebase.
- The heartbeat scheduler (routine sweeps, the terminal-workspace reaper, the adapter-login
  reaper, etc. — see `index.ts`) runs as in-process `setInterval` timers gated by a single
  `HEARTBEAT_SCHEDULER_ENABLED` flag. Two instances both running this flag `true` would double-run
  every sweep with no coordination.

No docs (`docs/`, `README.md`) mention clustering, horizontal scaling, or HA anywhere in this repo.

### 3.3 Agent execution workers are local child processes *on this instance today* — but a distributed path already exists upstream, unused here

The core finding, from code: every agent run on this instance — every CLI process actually
editing code, running commands, and touching an issue, across every company and every project — is
spawned with Node's `child_process.spawn()` directly inside the single server process
(`server/src/services/native-runtime/native-codex-runner.ts:214`). This *is* the currently active
path here. It's why the Deployment carries generous resource limits (8 CPU / 16Gi memory) against
a tiny idle baseline (~0.1 CPU, ~1.4Gi) — headroom for concurrent agent child processes, not the
web server itself.

Correction to an earlier read of this: the execution-workspace type system's `cloud_sandbox`
strategy value (`execution-workspace-policy.ts`) is not dead/aspirational. `workspace-runtime.ts`
has no dispatch for it because the dispatch lives in a **separate, documented plugin system** —
`environmentDriver`s of kind `sandbox_provider`, installed from the Plugin Manager
(`packages/plugins/sandbox-providers/` upstream; see `docs.paperclip.ing` → Reference → Adapters →
Sandbox Providers). This is a mature, multi-provider ecosystem, not a stub: Cloudflare, Daytona,
exe.dev, E2B, Modal, and Novita AI all ship as first-party plugins that provision genuinely
external compute per agent run. Most relevant here: **`@paperclipai/plugin-kubernetes`**
(alpha, self-hostable) runs each agent run as its own pod in your own cluster — one tenant
namespace per company, a hardened pod per run (`runAsNonRoot`, dropped capabilities, read-only
rootfs, deny-all `NetworkPolicy` baseline), optional Firecracker microVM isolation via
`runtimeClassName: kata-fc`, and a `job` backend that needs nothing beyond Kubernetes 1.27+ (a
current cluster already clears that floor) — no extra CRDs or controllers required for
that backend.

Checked directly: **this instance has no sandbox-provider plugin installed** — only the base
`plugin-sdk`. So the gap described above (§3.1 heading, "agent execution as local child processes")
is accurate for *this specific deployment*, but the fix is "install and configure an existing
plugin," not "build distributed agent execution from scratch." That materially changes §5's Phase 2
— see the revised discussion there.

### 3.4 Execution workspaces accumulate without bound in practice

The volume held ~2.3M inodes, most of it per-issue git worktrees under
`instances/<company>/projects/<project>/<repo>/worktrees/<branch>`, several carrying a full
`node_modules` (pnpm-hardlinked, so `du` overstates unique bytes, but inode count is real and not
deduplicated — each worktree's `node_modules` is its own full directory *structure* even when file
*content* is shared via the pnpm store).

There is a real cleanup mechanism (`PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS`, default 7,
`server/src/config.ts`), running as a heartbeat-scheduled sweep
(`executionWorkspaceService.sweepTerminalWorkspaces`) that archives a workspace N days after its
issue's entire *tree* (the issue plus every ancestor/descendant) goes terminal. In practice this
still leaves long-lived worktrees on disk, because the sweep skips a candidate for any of:
`skippedActiveRun`, `skippedNonTerminalTree`, `skippedUndelivered`, `skippedRace`,
`skippedCooldown`. `skippedNonTerminalTree` alone explains most of what was found today: a single
still-open parent epic or sibling issue holds the entire tree's worktrees hostage indefinitely,
even when the specific issue that produced a given worktree is long done.

The stated rationale for the cooldown (from the code comment): "a person can reopen the work
inside this window" — i.e. it exists to let a human resume a just-finished issue without losing
the checkout, uncommitted diffs, or installed dependencies. That is a real value; the gap is that
non-terminal-tree skipping has no upper bound, so "temporary" retention can become permanent for
an epic that stays open a long time.

### 3.5 Storage is replicated, but not where the compute is

Longhorn replicates `paperclip-data-lh` across two nodes for durability
(`numberOfReplicas: 2`, confirmed replicas on the two nodes with enough raw disk
(roughly 1T each) to hold a 120Gi volume; the remaining nodes have far less and could not fit a
replica of this volume at all).

`dataLocality` is `disabled`, and nothing pins the pod to a node that holds a replica. The
pod landed on a node with *neither* replica, and incidentally the most CPU-contended node in the
cluster at the time. Every read and write the pod issued
during the 45-minute ownership scan crossed the network to reach a replica; there was no local-disk
path available at all. This is independent of the HA/clustering question but compounds it: even a
single-instance deployment pays an avoidable network-latency tax today.

### 3.6 Not all storage is single-node-only — attachment storage already has a multi-node path

The official docs (`docs.paperclip.ing` → Reference → Deploy → Storage) draw an explicit line: file
*attachments and uploads* (issue attachments, screenshots) go through a separate, configurable
storage provider, distinct from the execution-workspace volume discussed above. The docs literally
list `s3` as the choice for "Production, multi-node, cloud deployments," versus `local_disk` for
"single-machine use." This instance has never been checked for which mode it's in — worth doing —
but the more important point for this spec is architectural: Paperclip's own docs already
distinguish storage that's designed to support multi-node deployment (attachments, via S3) from
storage that implicitly isn't (execution workspaces — no S3/object-storage option is documented or
found in code for git worktrees, and none would make sense for a live git checkout a process needs
POSIX filesystem semantics against). This confirms §3.1's RWO constraint isn't an oversight to
fix — it's the correct tool for what that volume holds; the path to multi-node is splitting what's
been living on one general-purpose volume by what each piece of data actually needs, not finding a
multi-node-capable replacement for the whole thing at once.

## 4. What Was Already Fixed (2026-08-30)

Two mitigations shipped as part of the incident response, on branch
`fix/entrypoint-root-only-ownership-check`:

1. **Shallow startup ownership check.** `scripts/docker-entrypoint.sh`'s ownership probe changed
   from a first-mismatch `find` over the *entire* tree to `find -maxdepth 1` — root directory plus
   immediate children only. Mirrors the same trade-off already accepted on the kubelet side
   (`fsGroupChangePolicy: OnRootMismatch`): trust shallow ownership as a proxy for
   the whole volume instead of paying for a full walk on every restart. Trade-off stated in the
   commit: a mismatch confined to a genuinely deep path is no longer self-healed at boot; it now
   surfaces as a diagnosable `EACCES` at runtime instead of a silent multi-hour boot.
2. **Weekly background full audit**, backfilling the gap the shallow check leaves. Runs
   backgrounded (`&`) and `nice -n 19`'d so it never blocks startup or competes with the app for
   I/O; a marker file on the volume (not in-process state, so it survives restarts) tracks last-run
   time so restarts more frequent than the interval — the common case — cost one `stat()` call, not
   a tree walk. Interval configurable via `PAPERCLIP_OWNERSHIP_AUDIT_INTERVAL_DAYS` (default 7).

Not yet done, identified but not applied (would themselves trigger a restart, deferred to avoid
paying the current slow-boot cost a third time in one incident):

- Pin the Deployment to a node that already holds a Longhorn replica via
  `nodeSelector`/`nodeAffinity`, instead of letting the scheduler place it anywhere.
- Set `dataLocality: best-effort` on the volume/StorageClass once the pod is pinned, so reads are
  served from the co-located replica instead of crossing the network. (Writes still commit
  synchronously to both replicas regardless of pod placement — this helps read-heavy operations,
  not write-heavy ones like `chown -R`.)

That branch's CI currently shows failures in `server/__tests__/routines-service.test.ts` (a Postgres
insert error); confirmed unrelated to this change (the diff touches only a shell script no
JS/TS test exercises) — looks like pre-existing flaky test infra, not investigated further here.

## 5. Path Toward HA and Clustering

Ordered by cost and how much they change the current architecture. Each phase should stand alone
as shippable value; none of this requires committing to the phase after it.

### Phase 0 — Reduce blast radius of the single instance (no architecture change)

- Apply the deferred node-pinning + `dataLocality: best-effort` from §4.
- Tighten the terminal-workspace reaper: cap how long a non-terminal-tree skip can hold a
  worktree hostage (today: unbounded), independent of whether the specific issue is done.
- Separate durable app state from regenerable scratch state onto different volumes: git worktrees
  and `node_modules` can be re-cloned/reinstalled and do not need Longhorn's synchronous
  cross-node replication at all; only genuinely irreplaceable data needs that durability
  guarantee. A `local-path` (non-replicated, node-local) volume for the scratch tree would remove
  the network round-trip cost entirely for that data, at the cost of losing in-progress
  uncommitted work if that specific node is lost — a real trade-off to make explicitly, not
  a free win.
- Result: restarts get faster and cheaper, but the instance is still a single point of failure.

### Phase 0.5 — Distribute agent execution across nodes (deployment-only, no upstream code needed)

This is the one phase that's just adopting something that already exists (§3.3), not building
anything. Install `@paperclipai/plugin-kubernetes`, configure a sandbox environment with
`driver: kubernetes`, `inCluster: true` (paperclip-server already runs in this cluster), and start
with the `job` backend (stable, no extra CRDs — a current cluster already clears the 1.27+ floor).
Point specific issues/companies at that environment via `executionWorkspaceSettings`.

What this buys: agent runs execute as their own pods, scheduled by Kubernetes across whichever
nodes have capacity — no longer contending with the paperclip server pod's own CPU/memory, and no
longer bound to whichever single node that pod happens to be on. This is real load distribution
across the existing hardware, today, without touching `server/src`.

What it does not buy: the control-plane constraints in §3.1/§3.2/§3.5 are untouched. The API
server, the heartbeat scheduler, and the one RWO volume backing execution-workspace *storage*
(worktree checkouts, as distinct from the compute now running elsewhere) are all still a single
instance. If that instance goes down, no agent runs get scheduled or tracked even if the
Kubernetes-provisioned run pods are still technically alive. This phase fixes the "workers" half of
"HA and clustering," not the "control plane" half — genuinely worth doing on its own, but don't
mistake it for full HA.

Worth a real test before committing further: does `sandbox-cr` (the multi-command backend that
adapter installation needs) matter for these workloads, or is `job`'s one-shot-entrypoint
limitation acceptable? That decides whether installing the `agent-sandbox` CRD/controller
(alpha) is worth it here.

### Phase 1 — Warm standby, not active-active

Keep a single active writer (the RWO/single-process constraints in §3.1-3.2 don't go away), but
remove the "any restart costs tens of minutes" failure mode by keeping a second, cold/warm pod
ready to take over:

- Requires solving the storage handoff: either RWX storage (Longhorn supports it via an NFS
  share-manager, at a performance cost for this workload) that a passive replica could mount
  read-only, or a fast volume-attach handoff (detach from the dying node, attach to the standby)
  rather than relying on Kubernetes' own pod-replacement path.
- Does not require touching the in-memory job-state assumptions in §3.2, because only one
  instance is ever actually running application code at a time.

### Phase 2 — Real multi-instance / active-active

The large undertaking. Requires, at minimum:

- Moving all execution-relevant state out of process memory and into Postgres (partially true
  today; §3.2's apply-jobs and heartbeat-scheduler state are the known gaps).
- A work-assignment/routing layer so a given execution workspace's operations always land on
  whichever instance actually holds that workspace's data — this is closer to a StatefulSet with
  per-replica `volumeClaimTemplates` than a `Deployment` with `replicas: N` sharing one volume, or
  alternatively RWX storage plus real distributed locking per-worktree.
- Leader election (or an equivalent single-owner guarantee) for the heartbeat scheduler, so
  routine sweeps, the terminal-workspace reaper, and similar periodic jobs run exactly once across
  the fleet, not once per instance.
- This is a genuine upstream feature, not a deployment-side change — most of the work is in
  `server/src`, not in the deployment manifests.
- Agent execution itself is **not** a blocker for this phase, provided Phase 0.5 already shipped —
  once runs execute via a `sandbox_provider` plugin, they're already off the API server's own
  process tree and distributed across the cluster regardless of how many *control-plane* instances
  exist. What Phase 2 actually adds on top is redundancy for the API server and scheduler
  themselves — the part Phase 0.5 explicitly does not touch.

## 6. Open Questions

- What is the actual RPO/RTO target? "Restart shouldn't take 45 minutes" (Phase 0) and "the
  product survives a node dying" (Phase 1/2) imply very different amounts of work — which is
  actually needed for a single-operator self-hosted instance, as opposed to a multi-tenant SaaS?
- Is RWX storage (NFS share-manager) fast enough for the git-worktree-heavy workload in practice,
  or does the added translation layer make Phase 1/2 worse than Phase 0's node-pinned single
  instance? Needs a real benchmark before committing to that path.
- Does splitting scratch (worktrees) from durable state (§ Phase 0) change the reaper's cooldown
  math — if scratch loss is cheaper (re-clone + reinstall vs. losing real data), should the default
  cooldown be shorter than 7 days?

## 7. References

- Incident timeline and all findings: this document, 2026-08-30.
- Shipped mitigations (§4), branch `fix/entrypoint-root-only-ownership-check`.
- The analogous kubelet-side `fsGroupChangePolicy: OnRootMismatch` setting, whose reasoning the
  shallow-check trade-off mirrors.
- `paperclipai/paperclip-docs` (docs.paperclip.ing) — `reference/deploy/storage.md` (§3.6),
  `reference/deploy/deployment-modes.md` (checked, not directly relevant — auth/exposure only),
  `reference/adapters/sandbox-providers.md` (§3.3, §5 Phase 0.5).
