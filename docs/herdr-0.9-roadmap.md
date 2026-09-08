# Herdr 0.9 integration roadmap

This roadmap turns Herdr 0.9 into herdr-axi's runtime substrate without moving
task correctness into terminal lifecycle heuristics.

## Ownership boundary

| Herdr owns | herdr-axi owns |
| --- | --- |
| Servers, sessions, terminals, panes, agent identity and lifecycle | Runs, phases, task dependencies and capacity |
| Ordered prompt submission and server-side waits | Delivery policy and ambiguous-delivery recovery |
| Local/SSH machine connectivity and combined TUI navigation | Host-local run state and optional cross-host summaries |
| Live socket events and point-in-time session snapshots | Generations, receipts, completion proof and human acceptance |
| Worktree discovery and workspace grouping | Writer leases and explicit checkout ownership |

An Herdr event is a wake hint. It is never task completion evidence. Only the
current generation's receipt/proof plus native settlement can enter review.

## Target runtime

```text
Herdr socket events ─┐
                     ├─ wake multiplexer ─ current-state reconciliation
Receipt filesystem ──┤                         │
Fallback timer ──────┘                         ├─ task/proof state machine
                                               └─ operator notification
```

The socket subscriber starts before the first state read. Once Herdr confirms
the subscription, any event arriving during reconciliation is buffered as a
pending wake. Subscription events have stream order but no resumable public
sequence number. Disconnect therefore means “resync current state,” never
“continue from the last event.”

## Current branch scope

| Slice | State |
| --- | --- |
| Hybrid event wake | Implemented for `watch`; receipts and timer remain authoritative fallbacks |
| Capability-aware degradation | Implemented for version/protocol/socket metadata and rejected subscriptions |
| Native diagnostics | Implemented as bounded `explain <pane> [--verbose]` |
| Multi-machine visibility | Implemented as read-only `machines`; no cross-host control |
| Operator notifications | Deferred until transition identity/deduplication can be persisted safely |
| Monitor consolidation | Deferred until the hybrid path has field evidence |

Subscriptions are rebuilt once per `watch` invocation. A generic
`pane.agent_detected` subscription wakes newly started/replaced worker topology;
the authoritative run-state change returns `state-change`, and re-arming then
subscribes to the new owned panes. If both lifecycle and filesystem notification
are unavailable, the timer detects that mutation and the response reports the
degraded transport explicitly.

## Vertical slices

### 1. Hybrid event wake

- Add a small newline-delimited JSON socket client with bounded line size,
  bounded reconnect backoff, explicit acknowledgement, and clean cancellation.
- Subscribe to owned panes' `pane.agent_status_changed` plus close/exit events.
- Combine it with receipt `fs.watch` and the existing timer reconciliation.
- Keep the CLI query path authoritative; no long-lived snapshot cache yet.

Result: faster blocked/done/lost detection and fewer periodic CLI probes,
without changing completion semantics or betting correctness on event replay.

### 2. Capability-aware degradation

- Record socket path, client/server versions, private protocol compatibility,
  endpoint capabilities, and stale-server state at `run init`.
- Treat unavailable/unknown optional methods as feature degradation.
- Treat server absence, Herdr <0.9, and private protocol incompatibility as
  startup failures.
- Surface active/degraded wake transport in `watch` results and diagnostics.

### 3. Native diagnostics

- Add `herdr-axi explain <pane>` as a compact projection of
  `herdr agent explain --json` for unknown/blocked detection disputes.
- Preserve raw backend evidence only behind an explicit verbose option.
- Add detection-manifest health to operator diagnostics without reloading it.

### 4. Multi-machine visibility

- Add read-only `herdr-axi machines` from `herdr machine list --json`.
- Clearly label profiles as connection inventory, not globally addressable
  workers. Pane IDs remain server-scoped.
- A later host aggregator executes herdr-axi on each intended host/session;
  selecting a machine in the TUI never retargets a local CLI process.

### 5. Operator notifications

- Make notifications opt-in per run/config.
- Notify only on transitions requiring attention: blocked, review-ready, lost,
  and run finished. Deduplicate by task generation and state.
- Notification failure is maintenance telemetry, never a failed transaction.

### 6. Monitor consolidation

Only after the hybrid wake path has field evidence, replace the monitor's dual
`agent wait` subprocesses with one socket subscriber. The replacement must
retain occupant identity fencing, receipt generation checks, reconnect resync,
hook-derived quota/context signals, and the visible monitor pane. Roll back to
the current waiter implementation if any invariant cannot be demonstrated.

## Failure contracts

| Failure | Required behavior |
| --- | --- |
| Socket unavailable or method unsupported | Continue with receipt watcher and timer; report degraded transport once |
| Subscription disconnect | Mark resync pending, reconnect with bounded backoff, reread authoritative state |
| Malformed or oversized line | Drop connection, report protocol degradation, never apply partial data |
| Event during initial reconciliation | Preserve a pending wake after subscription acknowledgement |
| `agent_prompt_stalled` or timeout | Assume input may have arrived; preserve worker and never resend or press Enter |
| Server binary differs from client | Use server version as behavior owner; warn when the operator expected new server behavior |
| Remote profile disconnected | Show cached/profile state as non-live; never target duplicate server-scoped IDs locally |

## Code-quality constraints

- Keep process CLI adaptation, socket transport, wake multiplexing, and run
  state in separate modules.
- Dependency-inject sockets and timers at the transport boundary for isolated
  tests; production code must not need a live Herdr server to test framing.
- Bound every line, buffer, timeout, retry, and returned diagnostic.
- Use typed internal result objects and one error translation boundary.
- Do not duplicate lifecycle-to-task transitions between JavaScript and Bash.
- Prefer one authoritative reread after a hint over maintaining a second cache.
