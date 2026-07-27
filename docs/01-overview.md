# 01 · Overview

## The problem

A venue needs to play recurring audio messages — safety announcements, closing calls, gallery
wayfinding — on a schedule, across different physical areas ("zones"), and needs a way to fire an
emergency announcement instantly. QLab is superb at *playing* audio, but it has no notion of "every
20 minutes between 09:00 and 17:00 on weekdays," and building each playback event by hand doesn't
scale. Operators should think in terms of *schedules* and *messages*, never in terms of cues,
timers, or OSC.

## What the system does

It adds a purpose-built scheduling layer on top of QLab:

- **Schedules** — a cue played on a recurring interval, optionally restricted to an active time
  window, specific weekdays, and a date range.
- **VOG (Voice-of-God)** — manually-triggered emergency messages that preempt whatever is playing.
- **Zones** — independent audio areas; the system keeps messages from colliding within a zone and
  lets unrelated zones play simultaneously.
- **A live operator UI** — list/create/edit/enable schedules and VOG messages, test with "play
  now," watch each zone's queue in real time, and review event history and QLab connection status.

QLab is unchanged: the operator pre-builds the message cues there under a stable numbering
convention, and this system only *triggers and queries* them.

## The rules that shaped it

These are hard requirements, not preferences — everything downstream follows from them:

- **QLab owns all audio.** Media, routing, fades, and ducking all live in QLab. This system never
  creates or edits cues; it triggers them by number and reads their duration/zones live.
- **Nothing overlaps within a zone.** Two messages due for the same zone queue and wait — they
  never play over each other. Unrelated zones are fully independent.
- **Skip, don't replay.** If occurrences pile up (QLab was down, a zone was busy), stale ones are
  dropped rather than fired in a catch-up burst.
- **Stay disarmed until QLab is confirmed live.** The scheduler won't fire anything until a
  heartbeat confirms QLab is responding, and it disarms the instant that link drops.
- **Zones are derived, not tagged.** Zone membership comes from each cue's QLab Audio Patch
  assignment, cross-referenced against one small manual map — the only manual zone config anywhere.
- **No authentication, by design.** Access is gated entirely by physical (KVM) and network
  (locked-down LAN) perimeter; nothing in the app authenticates. It binds to loopback only.

## Where to go next

- The three-process design and why it's split that way → [02 · Architecture](02-architecture.md).
- The vocabulary (zones, schedules, VOG, ducking, arming) → [03 · Domain concepts](03-domain-concepts.md).
- How collisions are actually resolved → [04 · Queue engine](04-queue-engine.md).
