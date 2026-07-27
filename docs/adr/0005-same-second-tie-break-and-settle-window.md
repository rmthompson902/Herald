# ADR 0005: Same-second tie-break and admission settle window

## Status

Accepted (Phase 8; the settle window added after a caught-in-production bug).

## Context

The original tie-break — "exact ties broken by schedule id" — in practice meant whichever cron-plus
job happened to be processed first internally, nothing an operator could reason about or control,
and a real report showed it consistently favoring the *wrong* cue.

## Decision

**Same-second collisions order by cue number ascending, backed by a short admission settle window.**

Two entries due within the same wall-clock second (`Math.floor(dueAt / 1000)` equal, not requiring
exact-millisecond equality) are ordered by cue number ascending — lower cue number plays first.

**Cue-number ordering alone was not sufficient and shipped as a real bug:** two schedules "due at
the same moment" don't actually reach `enqueue()` in the same instant — cron-plus dispatches them a
few ms apart — so whichever arrived first into a free zone was admitted immediately, before the
other even existed to be compared against. Fixed by having admission into a newly-free zone always
wait out a short settle window (`admissionSettleMs`, default 75ms) before picking a winner, so a
near-simultaneous sibling has a chance to arrive and be sorted in first.

This adds a small fixed delay to *every* fire through a zone, not just contested ones (there's no
way to know in advance whether a collision is imminent) — accepted as negligible for both routine
announcements and VOG triggers (see [ADR 0009](0009-vog-preemption.md)) given cue playback durations
are measured in seconds. Entries due in different seconds are unaffected and still order strictly by
due time regardless of cue number; none of this affects genuinely single-zone, uncontested fires
beyond the flat settle delay.
