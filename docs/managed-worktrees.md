# Managed worktrees: proposed contract

Status: investigated for Herdr 0.9; design approved for contract-first implementation, not yet implemented.

## Decision

Add optional, stream-scoped worktree isolation. Keep explicit `--cwd` as the default and keep the existing cross-run leases in every mode. Automatic isolation must initially require `--isolate`; a future `worktrees.mode: on-conflict` may be considered only after live fault-injection coverage.

The intended queue shape is:

```sh
herdr-axi run queue TASK --cwd SOURCE --area AREA --isolate \
  [--stream EPIC] [--base REF] --prompt 'task; checks'
```

`--cwd` identifies the source checkout. The managed checkout is created lazily by `run next`, only after a writer becomes eligible. A stream reuses one worktree/workspace for dependency-ordered writers; readers keep current sharing rules unless explicitly isolated.

## Ownership boundary

- herdr-axi owns policy, names, task/stream binding, leases, durable provenance, reconciliation and cleanup eligibility.
- Herdr owns `worktree create/open/remove`, workspace creation, returned pane/workspace IDs and UI grouping.
- Git read-only probes remain authoritative for repository identity, base OID, branch and cleanliness.
- The user owns merges, rebases, pushes, branch deletion and every worktree not created by the active run.

Herdr 0.9 exposes `worktree list/create/open/remove`, but no capability bit. Availability must be probed from the command contract and failures must remain non-destructive. herdr-axi never passes `--force` or `--trust-repository` automatically.

## State model

Runs need a durable `managedWorktrees[]` collection before creation is enabled:

```text
id, repoKey, source, stream, baseOid, branch, path,
workspace, rootPane, state, createdAt, taskIds
```

Tasks reference a managed-worktree ID. Workers must carry their own workspace identity; the current run-wide `workspace` assumption is insufficient because Herdr opens each worktree as a distinct workspace.

## Creation and recovery saga

1. Require a clean, resolvable Git source and resolve `--base` to an immutable OID. Dirty sources never imply an invisible snapshot.
2. Persist a unique branch/path reservation with state `requested`, then `creating`, before calling Herdr.
3. Call `herdr worktree create --cwd SOURCE --base OID --branch GENERATED --no-focus`. The canonical source path comes from the validated queue request, so creation does not depend on that checkout already having an open Herdr workspace.
4. Verify returned repository, path, branch, workspace and root pane; persist `ready` before starting a worker.
5. Acquire the existing canonical worktree lease, then start the worker in the returned workspace/pane.
6. On timeout or malformed response, reconcile with `herdr worktree list --cwd SOURCE`. Never retry creation blindly. Ambiguous ownership remains durable and blocks reuse.
7. Acceptance or cancellation releases the writer lease but retains the checkout for its stream.

Creation is bounded by phase capacity. Submodules, LFS, sparse checkouts and repository hooks remain manual initially because creation can require network, credentials or extra mutable state.

## Cleanup invariants

Cleanup is an explicit command and starts as report/dry-run only. Non-force removal is eligible only when all of these are verified:

- exact run provenance still matches path, branch and workspace;
- no active task, worker, pane, tab or lease references the checkout;
- Git status is clean, including untracked files;
- all owned worker tabs in that workspace are already closed;
- the worktree is not the source checkout and not externally adopted.

Removal failure preserves the record for recovery. Branch deletion is never automatic. herdr-axi never stashes, resets, merges, force-removes or closes a parent/source workspace.

## Delivery sequence

1. State/CLI contract tests and fake-Herdr create/reconcile/remove fixtures.
2. Read-only planner and persisted provenance, with no worktree mutation.
3. Per-worker workspace support in ownership, receipts, recovery, takeover and engine calls.
4. Explicit `--isolate` creation plus timeout/restart fault injection.
5. Explicit `run cleanup-worktrees`, report-first and never force.
6. Live multi-stream E2E; only then evaluate `on-conflict` automation.

This design improves parallel throughput without weakening the current rule: leases prevent competing writers even when worktree creation or reconciliation fails.
