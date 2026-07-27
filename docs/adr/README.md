# Architecture Decision Records

Each record captures one decision behind the zone queue engine
([`lib/queue/zoneQueueEngine.js`](../../lib/queue/zoneQueueEngine.js)) — the rule, why it exists, and
(where relevant) the bug or live-test finding that drove it. For the current behavior in summary,
see [04 · Queue engine](../04-queue-engine.md); these ADRs are the full rationale behind it.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-per-zone-fifo-queue-model.md) | Per-zone FIFO queue model | Accepted |
| [0002](0002-zone-free-detection.md) | Zone-free detection (`/updates` push, fallback timer, denied-start free) | Accepted |
| [0003](0003-confirm-before-fire.md) | Confirm live before firing | Accepted |
| [0004](0004-independent-per-zone-fifos.md) | Independent per-zone FIFOs | Accepted (supersedes multi-zone admission) |
| [0005](0005-same-second-tie-break-and-settle-window.md) | Same-second tie-break and admission settle window | Accepted |
| [0006](0006-stale-drop-repeated-schedule-fires.md) | Stale-drop for repeated schedule fires | Accepted |
| [0007](0007-per-zone-overflow-cap.md) | Per-zone overflow cap | Accepted |
| [0008](0008-play-now-through-the-queue.md) | Play-now goes through the queue | Accepted |
| [0009](0009-vog-preemption.md) | VOG preemption | Accepted |
| [0010](0010-music-ducking.md) | Music ducking | Accepted |
| [0011](0011-concurrent-fire-cuelists-dedup.md) | Concurrent-fire `/cueLists` de-duplication | Accepted |
