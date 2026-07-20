'use strict';

// Per-zone occupancy + FIFO wait queue + stale-drop + VOG preempt, per
// docs/adr/0001-zone-queue-tiebreak-policy.md. Pure/in-memory - nothing here is durable by
// design (see plan: losing in-flight queue state on restart is correct, cron-plus jobs are
// fully rebuilt from schedules on boot instead of resuming any in-flight queue).
//
// A cue may be audible in more than one zone at once (see zoneResolver) - an entry only
// fires once EVERY one of its target zones is simultaneously free. A single-zone entry
// behind it in one of those zones' queues is free to be admitted in the meantime if that
// zone alone is available to it - a multi-zone entry blocked on some OTHER zone does not
// head-of-line-block unrelated entries in the zones it's not actually stuck on (see
// _findReadyEntry). The reverse is still true and intentional: a multi-zone entry itself
// can be held up by an unrelated single-zone entry that got there first and is ready to go
// in one of its zones - that's what "wait your turn in every zone you need" means. Both are
// documented as decisions in the ADR rather than hidden here.
//
// Admission is always confirm-before-fire: our own duration-based estimate of when a cue
// finishes can be a hair shorter than QLab's real wall-clock playback (fade tails,
// rounding), and retriggering the same cue number while QLab is still finishing the
// previous instance can be silently ignored on QLab's side (no error, just no audible
// second play). So before ever sending a real OSC start for a candidate, the engine
// live-confirms via `qlabProtocol.getIsRunningByUniqueId` that the cue is not already
// running, retrying briefly if it is, rather than trusting internal bookkeeping alone.
//
// Admission into a currently-free zone also always waits out a short settle window first
// (see _startSettling) - two schedules configured for the "same" due moment don't actually
// reach enqueue() at the same instant (cron-plus dispatches them a few ms apart), so
// without a brief window to let a near-simultaneous sibling arrive and be sorted in, the
// cue-number tie-break in _compareEntries below never gets a chance to apply - whichever
// happened to arrive first would just fire immediately before the other even existed.

const DEFAULT_MAX_QUEUE_LENGTH = 5;
const DEFAULT_FALLBACK_DURATION_SECONDS = 30;
const DEFAULT_CONFIRM_RETRY_DELAY_MS = 150;
const DEFAULT_CONFIRM_MAX_ATTEMPTS = 20; // ~3s worst case before firing anyway as a safety net
const DEFAULT_ADMISSION_SETTLE_MS = 75; // just enough to catch cron-plus's own dispatch jitter
const MAX_RECENT_EVENTS = 200;

class ZoneQueueEngine {
  /**
   * @param {object} qlabProtocol - exposes playCue(cueNumber), getIsRunningByUniqueId(uid)
   * @param {object} [options]
   * @param {() => number} [options.clock] - injectable for tests
   * @param {(fn: Function, delayMs: number) => any} [options.setTimer] - injectable for tests
   * @param {(timer: any) => void} [options.clearTimer]
   * @param {number} [options.maxQueueLength]
   * @param {number} [options.confirmRetryDelayMs]
   * @param {number} [options.confirmMaxAttempts]
   * @param {number} [options.admissionSettleMs]
   * @param {(event: string, entry: object, extra?: object) => void} [options.onEvent] - business
   *   event hook (fired/queued/dropped_stale/queue_overflow_dropped/zone_freed/confirm_wait/
   *   confirm_timeout_firing_anyway) - wire to lib/log/eventLogger.js from the caller, not
   *   logged internally. Every call is also recorded in the recent-events ring buffer
   *   regardless of whether a hook is provided - see getRecentEvents().
   */
  constructor(qlabProtocol, options = {}) {
    this._protocol = qlabProtocol;
    this._clock = options.clock || (() => Date.now());
    this._setTimer = options.setTimer || ((fn, delayMs) => setTimeout(fn, delayMs));
    this._clearTimer = options.clearTimer || ((timer) => clearTimeout(timer));
    this._maxQueueLength = options.maxQueueLength ?? DEFAULT_MAX_QUEUE_LENGTH;
    this._fallbackDurationSeconds = options.fallbackDurationSeconds ?? DEFAULT_FALLBACK_DURATION_SECONDS;
    this._confirmRetryDelayMs = options.confirmRetryDelayMs ?? DEFAULT_CONFIRM_RETRY_DELAY_MS;
    this._confirmMaxAttempts = options.confirmMaxAttempts ?? DEFAULT_CONFIRM_MAX_ATTEMPTS;
    this._admissionSettleMs = options.admissionSettleMs ?? DEFAULT_ADMISSION_SETTLE_MS;
    this._userOnEvent = options.onEvent || (() => {});

    this._queues = new Map(); // zoneName -> entry[] (FIFO, sorted by dueAt asc)
    this._occupancy = new Map(); // zoneName -> { entry, expectedEndAt, timer, confirmed }
    this._settling = new Map(); // zoneName -> { timer, promise, resolveSettled }, see _startSettling
    this._settled = new Set(); // zoneName -> already completed a settle window this contest, see _tryAdvance
    this._recentEvents = [];
  }

  /**
   * Admits or queues an entry. Entries are plain objects:
   *   { id, scheduleId, dedupeKey, cueNumber, qlabInternalId, zones, durationSeconds, dueAt, name, source }
   * `dedupeKey` (only set for cron-plus schedule fires, not play-now/VOG) triggers stale-drop
   * of a prior still-waiting entry sharing the same key - see ADR.
   *
   * Resolves once we know the outcome for THIS entry: either it fired (after a live
   * confirm, possibly with a few retries if the cue looked still-running) or it's now
   * waiting behind something else. A later "was queued, now actually fired" transition is
   * recorded in the recent-events buffer (see getRecentEvents) for the caller to surface as
   * a follow-up notification, since the caller can't wait around for that synchronously.
   *
   * @returns {Promise<{ fired: boolean }>}
   */
  async enqueue(entry) {
    // A cue resolving to zero zones (fully muted / not routed anywhere) has nothing to
    // collide over - admit it directly rather than pushing it into no queue at all, where
    // it would never be found by _findReadyEntry and would hang forever unfired.
    if (entry.zones.length === 0) {
      await this._beginAdmission(entry);
      return { fired: true };
    }

    if (entry.dedupeKey) {
      this._dropStaleDuplicates(entry.dedupeKey, entry.id);
    }

    for (const zone of entry.zones) {
      const queue = this._queues.get(zone) || [];
      queue.push(entry);
      queue.sort((a, b) => this._compareEntries(a, b));
      this._queues.set(zone, queue);
    }

    this._enforceCap(entry.zones);
    this._emit('queued', entry);
    this._tryAdvance();

    // If any of this entry's zones just started a fresh settle window, wait it out before
    // deciding the outcome - otherwise every entry would look "queued" the instant it's
    // enqueued, since admission is deliberately deferred until the window closes (see
    // _startSettling). A zone that was already genuinely occupied (not just settling) has
    // no settle promise, so a truly-busy-zone entry still resolves immediately as before.
    const settlePromises = entry.zones.map((z) => this._settling.get(z)?.promise).filter(Boolean);
    if (settlePromises.length > 0) {
      await Promise.all(settlePromises);
    }

    if (entry._admissionPromise) {
      await entry._admissionPromise;
    } else {
      entry.wasQueued = true;
    }

    return { fired: entry.status === 'fired' };
  }

  /**
   * Called when the OSC layer receives a `/update/.../cue_id/{uniqueId}` push for a
   * uniqueId this engine currently has CONFIRMED occupying a zone - confirms via a live
   * isRunning query and frees the zone(s) early if QLab reports it actually stopped,
   * rather than waiting out the fallback duration timer. Deliberately ignores zones whose
   * occupant is still mid-admission (reserved but not yet confirmed) - that entry's own
   * confirm-retry loop in _beginAdmission already owns deciding when it's clear to fire.
   * Best-effort: failures just leave the fallback timer as the safety net.
   */
  async handleQlabUpdate(qlabInternalId) {
    if (!qlabInternalId || !this._isConfirmedOccupyingAnyZone(qlabInternalId)) return;

    let isRunning;
    try {
      isRunning = await this._protocol.getIsRunningByUniqueId(qlabInternalId);
    } catch {
      return;
    }
    if (!isRunning) {
      this._confirmStopped(qlabInternalId);
    }
  }

  /**
   * Clears occupancy (confirmed or still-reserving) and drops every waiting entry for the
   * given zones outright - no requeue. Used by vogInterruptHandler (Phase 9) once VOG
   * actually stops other cues; the caller is responsible for issuing the real OSC stop,
   * this only clears bookkeeping so admission isn't left blocked on a zone VOG just
   * silenced.
   */
  preemptZones(zoneNames) {
    for (const zone of zoneNames) {
      const occ = this._occupancy.get(zone);
      if (occ) {
        if (occ.timer) this._clearTimer(occ.timer);
        this._occupancy.delete(zone);
      }

      const settling = this._settling.get(zone);
      if (settling) {
        this._clearTimer(settling.timer);
        this._settling.delete(zone);
        // Unblock any enqueue() call awaiting this zone's settle promise (see enqueue) -
        // its entry just got dropped above, so it'll correctly resolve as queued/dropped,
        // not hang forever waiting on a settle window that will now never fire.
        settling.resolveSettled();
      }

      const queue = this._queues.get(zone) || [];
      for (const dropped of queue) {
        this._emit('vog_preempt_dropped', dropped, { zone });
      }
      this._queues.set(zone, []);
      this._settled.delete(zone);
    }
    this._tryAdvance();
  }

  /** Read-only snapshot for the status/history pages - never mutate the return value. */
  getState() {
    const occupancy = {};
    for (const [zone, occ] of this._occupancy) {
      occupancy[zone] = { entry: occ.entry, expectedEndAt: occ.expectedEndAt, confirmed: occ.confirmed };
    }
    const queued = {};
    for (const [zone, queue] of this._queues) {
      queued[zone] = queue.slice();
    }
    return { occupancy, queued };
  }

  /**
   * Recent business events (fired/queued/dropped_stale/...), oldest first, optionally
   * filtered to those at or after `sinceIso`. Used by the webapp to notice when a
   * previously-queued entry actually went on to fire, since that happens well after the
   * original request's HTTP response already went out - see node-red's
   * GET /api/queue/events.
   */
  getRecentEvents(sinceIso) {
    if (!sinceIso) return this._recentEvents.slice();
    return this._recentEvents.filter((e) => e.at > sinceIso);
  }

  _emit(event, entry, extra) {
    const record = {
      event,
      at: new Date(this._clock()).toISOString(),
      entry: {
        id: entry.id,
        scheduleId: entry.scheduleId ?? null,
        cueNumber: entry.cueNumber,
        zones: entry.zones,
        name: entry.name ?? null,
        wasQueued: entry.wasQueued === true
      },
      extra: extra ?? null
    };
    this._recentEvents.push(record);
    if (this._recentEvents.length > MAX_RECENT_EVENTS) this._recentEvents.shift();
    this._userOnEvent(event, entry, extra);
  }

  /**
   * FIFO by due time, but two entries due within the same wall-clock second are treated as
   * a genuine tie (rather than whichever happened to reach enqueue() a few ms first, which
   * in practice just reflected cron-plus's internal job-processing order, not anything an
   * operator controls) and broken by cue number ascending instead - lower cue number plays
   * first. Falls back to entry id if cue numbers are equal or non-numeric.
   */
  _compareEntries(a, b) {
    const secondsA = Math.floor(a.dueAt / 1000);
    const secondsB = Math.floor(b.dueAt / 1000);
    if (secondsA !== secondsB) return secondsA - secondsB;

    const cueA = parseFloat(a.cueNumber);
    const cueB = parseFloat(b.cueNumber);
    if (!Number.isNaN(cueA) && !Number.isNaN(cueB) && cueA !== cueB) return cueA - cueB;

    return String(a.cueNumber).localeCompare(String(b.cueNumber)) || String(a.id).localeCompare(String(b.id));
  }

  _dropStaleDuplicates(dedupeKey, exceptEntryId) {
    for (const [zone, queue] of this._queues) {
      const stale = queue.filter((e) => e.dedupeKey === dedupeKey && e.id !== exceptEntryId);
      if (stale.length === 0) continue;
      this._queues.set(zone, queue.filter((e) => !stale.includes(e)));
      for (const entry of stale) {
        this._emit('dropped_stale', entry, { zone });
      }
    }
  }

  _enforceCap(zones) {
    for (const zone of zones) {
      let queue = this._queues.get(zone) || [];
      while (queue.length > this._maxQueueLength) {
        const oldest = queue[0];
        this._dropEntry(oldest, 'queue_overflow_dropped');
        queue = this._queues.get(zone) || [];
      }
    }
  }

  /** Removes an entry from every zone queue it's waiting in (it may span more than one). */
  _dropEntry(entry, eventName) {
    for (const [zone, queue] of this._queues) {
      const index = queue.indexOf(entry);
      if (index !== -1) {
        queue.splice(index, 1);
        this._emit(eventName, entry, { zone });
      }
    }
  }

  /**
   * Starts (or continues) settle windows for any newly-contestable zone, then reserves
   * zone(s) for every ready candidate (synchronously, so nothing else can be picked for
   * those zones), and lets each candidate's own confirm-and-fire chain run independently
   * and asynchronously - a slow confirm on one zone never blocks admission on an unrelated
   * zone.
   */
  _tryAdvance() {
    for (const [zone, queue] of this._queues) {
      if (queue.length === 0) {
        // Nothing left to protect with a settle window - clear the flag so a future new
        // arrival into this now-empty zone gets a fresh one, rather than being treated as
        // part of a contest that already resolved.
        this._settled.delete(zone);
        continue;
      }
      if (
        this._admissionSettleMs > 0 &&
        !this._occupancy.has(zone) &&
        !this._settling.has(zone) &&
        !this._settled.has(zone)
      ) {
        this._startSettling(zone);
      }
    }

    let candidate;
    while ((candidate = this._findReadyEntry())) {
      for (const zone of candidate.zones) {
        const queue = this._queues.get(zone) || [];
        const index = queue.indexOf(candidate);
        if (index !== -1) queue.splice(index, 1);
        this._occupancy.set(zone, { entry: candidate, expectedEndAt: null, timer: null, confirmed: false });
        // A fresh admission just happened - next time this zone frees, it's a new contest
        // and should get its own settle window again.
        this._settled.delete(zone);
      }
      candidate._admissionPromise = this._beginAdmission(candidate);
    }
  }

  /**
   * A short grace window before the first admission attempt into a zone that just became
   * contestable - two schedules "due at the same moment" don't actually reach enqueue() in
   * the same instant (cron-plus dispatches them a few ms apart), so without this, whichever
   * happened to arrive first would fire before the other even existed, and the cue-number
   * tie-break in _compareEntries would never get a chance to apply. Marks the zone `_settled`
   * once the window closes (rather than just clearing `_settling`) so the _tryAdvance() call
   * this triggers doesn't immediately restart another window for the same still-unresolved
   * contest - only a genuinely new contest (zone occupied then freed again, or queue emptied
   * and refilled) gets a fresh settle window.
   */
  _startSettling(zone) {
    let resolveSettled;
    const promise = new Promise((resolve) => {
      resolveSettled = resolve;
    });
    const timer = this._setTimer(() => {
      this._settling.delete(zone);
      this._settled.add(zone);
      this._tryAdvance(); // may admit candidates now, setting their _admissionPromise synchronously
      resolveSettled();
    }, this._admissionSettleMs);
    this._settling.set(zone, { timer, promise, resolveSettled });
  }

  /**
   * Scans each free zone's queue, in FIFO/cue-number order, for the first entry whose
   * *every* zone is currently free - not just literally the front of each of its zones'
   * queues. That stricter front-of-queue version was a real bug: a multi-zone entry that
   * can't fire yet (because one of its OTHER zones is busy) still occupies the front slot
   * of every zone it touches, head-of-line-blocking single-zone entries behind it that
   * have nothing to do with whichever zone it's actually stuck on - e.g. a cue routed to
   * Zone 1+2 sorting ahead of a Zone-2-only cue (lower cue number) would block that
   * Zone-2-only cue indefinitely even though Zone 2 itself was completely free. Scanning
   * past a not-yet-ready entry to find one that IS ready still preserves FIFO/cue-number
   * ordering among entries that are genuinely competing for the same zone, since the first
   * ready entry encountered in sorted order is always returned.
   */
  _findReadyEntry() {
    for (const zone of Array.from(this._queues.keys()).sort()) {
      const queue = this._queues.get(zone);
      if (!queue || queue.length === 0 || this._occupancy.has(zone) || this._settling.has(zone)) continue;

      for (const candidate of queue) {
        const ready = candidate.zones.every((z) => !this._occupancy.has(z) && !this._settling.has(z));
        if (ready) return candidate;
      }
    }
    return null;
  }

  /** Zone(s) already reserved synchronously by _tryAdvance - this only owns the confirm/fire. */
  async _beginAdmission(entry) {
    await this._confirmClearAndFire(entry, 0);
  }

  async _confirmClearAndFire(entry, attempt) {
    let stillRunning = false;
    if (entry.qlabInternalId) {
      try {
        stillRunning = await this._protocol.getIsRunningByUniqueId(entry.qlabInternalId);
      } catch {
        stillRunning = false; // best-effort: can't confirm, don't block forever on a query failure
      }
    }

    if (stillRunning && attempt < this._confirmMaxAttempts) {
      this._emit('confirm_wait', entry, { attempt });
      await this._delay(this._confirmRetryDelayMs);
      return this._confirmClearAndFire(entry, attempt + 1);
    }

    if (stillRunning) {
      this._emit('confirm_timeout_firing_anyway', entry, { attempts: attempt });
    }

    this._fire(entry);
  }

  _delay(ms) {
    return new Promise((resolve) => this._setTimer(resolve, ms));
  }

  _fire(entry) {
    const durationMs = (entry.durationSeconds ?? this._fallbackDurationSeconds) * 1000;
    const expectedEndAt = this._clock() + durationMs;
    for (const zone of entry.zones) {
      const timer = this._setTimer(() => this._freeZone(zone, entry), durationMs);
      this._occupancy.set(zone, { entry, expectedEndAt, timer, confirmed: true });
    }

    entry.status = 'fired';
    this._emit('fired', entry, { afterQueue: entry.wasQueued === true });
    Promise.resolve(this._protocol.playCue(entry.cueNumber)).catch((err) => {
      this._emit('error', entry, { message: err.message });
    });
  }

  _freeZone(zone, entry) {
    const occ = this._occupancy.get(zone);
    if (!occ || occ.entry !== entry) return;
    this._occupancy.delete(zone);
    this._emit('zone_freed', entry, { zone });
    this._tryAdvance();
  }

  _isConfirmedOccupyingAnyZone(qlabInternalId) {
    for (const occ of this._occupancy.values()) {
      if (occ.confirmed && occ.entry.qlabInternalId === qlabInternalId) return true;
    }
    return false;
  }

  _confirmStopped(qlabInternalId) {
    for (const [zone, occ] of Array.from(this._occupancy.entries())) {
      if (occ.confirmed && occ.entry.qlabInternalId === qlabInternalId) {
        this._clearTimer(occ.timer);
        this._freeZone(zone, occ.entry);
      }
    }
  }
}

module.exports = { ZoneQueueEngine };
