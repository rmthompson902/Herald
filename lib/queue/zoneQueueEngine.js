'use strict';

// Per-zone occupancy + FIFO wait queue + stale-drop + VOG preempt, per
// docs/adr/0001-zone-queue-tiebreak-policy.md. Pure/in-memory - nothing here is durable by
// design (see plan: losing in-flight queue state on restart is correct, cron-plus jobs are
// fully rebuilt from schedules on boot instead of resuming any in-flight queue).
//
// The engine is genuinely N independent per-zone FIFOs (see ADR decision 4's amendment) - a
// cue that's audible in more than one zone (see zoneResolver.resolveZoneDetailsForCue) is
// decomposed at enqueue() time into one independent sub-entry per zone, each carrying that
// zone's OWN specific child cue number/duration/uniqueId. Every sub-entry lives in exactly
// one zone's queue and is admitted, ducked, confirmed, fired, and freed entirely on that
// zone's own schedule - a zone's readiness never depends on any other zone's state. A
// single-zone entry is simply the N=1 case of this same decomposition, not a separate code
// path - this is what makes the FIFO behavior uniform across every trigger type (schedule
// fires, play-now, VOG) and every zone count.
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
//
// Ducking (see docs/adr/0001, decision 10) is modeled as genuine sequential phases, not a
// fire-and-forget side effect: a burst-starting entry's message cue doesn't fire until its
// zone's duck cue is confirmed done (onZoneTransition('duck', ...) is awaited before
// _confirmClearAndFire), and a zone isn't considered truly free again until its unduck cue
// is confirmed done either. Neither duck nor unduck ever repeats mid-burst.

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
   *   confirm_timeout_firing_anyway/duck_wait/unduck_wait) - wire to lib/log/eventLogger.js
   *   from the caller, not logged internally. Every call is also recorded in the
   *   recent-events ring buffer regardless of whether a hook is provided - see
   *   getRecentEvents().
   * @param {(kind: 'duck'|'unduck', zoneName: string) => Promise<void>} [options.onZoneTransition] -
   *   fired at exactly two moments: 'duck' when a zone goes from empty to occupied for the
   *   first time in a burst (awaited BEFORE the burst-starting entry's own confirm-before-fire
   *   chain runs - see _beginAdmission), 'unduck' once that zone's queue is confirmed fully
   *   drained afterward (awaited BEFORE the zone is considered free for new admission - see
   *   _maybeUnduck). Deliberately separate from onEvent - onEvent is passive logging, this
   *   one carries a required real OSC side effect (the caller plays the zone's duck/unduck
   *   cue and is expected to wait out its own real completion), so it's a distinct contract
   *   rather than overloading onEvent's. Best-effort: a throwing/rejecting hook must never
   *   break the engine's own state machine.
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
    this._onZoneTransition = options.onZoneTransition || (() => {});

    this._queues = new Map(); // zoneName -> entry[] (FIFO, sorted by dueAt asc)
    this._occupancy = new Map(); // zoneName -> { entry, expectedEndAt, timer, confirmed }
    this._settling = new Map(); // zoneName -> { timer, promise, resolveSettled }, see _startSettling
    this._settled = new Set(); // zoneName -> already completed a settle window this contest, see _tryAdvance
    this._ducked = new Set(); // zoneName -> duck has fired and unduck hasn't yet, see _tryAdvance/_maybeUnduck
    this._recentEvents = [];
  }

  /**
   * Admits or queues an entry. Entries are plain objects:
   *   { id, scheduleId, dedupeKey, cueNumber, qlabInternalId, zones, zoneDetails,
   *     durationSeconds, dueAt, name, source }
   * `zoneDetails` (from zoneResolver.resolveZoneDetailsForCue) maps each zone to ITS OWN
   * `{ cueNumber, durationSeconds, qlabInternalId }` - a Group cue's zones each play their
   * own specific child cue, never the group's own number. A zone missing from `zoneDetails`
   * (or the whole field being absent, e.g. a plain single-zone caller) falls back to the
   * entry's own top-level `cueNumber`/`durationSeconds`/`qlabInternalId` - this is what a
   * single-zone entry naturally does, since it needs nothing more.
   * `dedupeKey` (only set for cron-plus schedule fires, not play-now/VOG) triggers stale-drop
   * of a prior still-waiting entry sharing the same key, per zone - see ADR.
   *
   * A cue spanning N zones decomposes into N independent per-zone sub-entries here, each
   * pushed into ONLY that zone's own queue - see the class-level comment. This is the one
   * and only path for `zones.length >= 1`, regardless of trigger type or zone count; a
   * single-zone entry is just the N=1 case.
   *
   * Resolves once we know the outcome for THIS entry: `fired` is true only if EVERY one of
   * its zones fired immediately (after any duck-wait plus a live confirm, possibly with a
   * few retries if the cue looked still-running); if any zone is now waiting instead, this
   * resolves false even though other zones may have fired right away. A later "was queued,
   * now actually fired" transition per zone is recorded in the recent-events buffer (see
   * getRecentEvents) for the caller to surface as a follow-up notification, since the caller
   * can't wait around for that synchronously.
   *
   * @returns {Promise<{ fired: boolean }>}
   */
  async enqueue(entry) {
    // A cue resolving to zero zones (fully muted / not routed anywhere) has nothing to
    // collide over - admit it directly rather than pushing it into no queue at all, where
    // it would never be found by any zone's queue and would hang forever unfired. No zone
    // bookkeeping applies here at all (see _fire's `entry.zone` guard).
    if (!entry.zones || entry.zones.length === 0) {
      await this._beginAdmission(entry);
      return { fired: true };
    }

    const subEntries = entry.zones.map((zone) => this._buildZoneEntry(entry, zone));

    for (const sub of subEntries) {
      if (sub.dedupeKey) {
        this._dropStaleDuplicates(sub.zone, sub.dedupeKey, sub.id);
      }
      const queue = this._queues.get(sub.zone) || [];
      queue.push(sub);
      queue.sort((a, b) => this._compareEntries(a, b));
      this._queues.set(sub.zone, queue);
      this._enforceCap(sub.zone);
      this._emit('queued', sub);
    }

    this._tryAdvance();

    // If this entry's zone just started a fresh settle window, wait it out before deciding
    // the outcome - otherwise every entry would look "queued" the instant it's enqueued,
    // since admission is deliberately deferred until the window closes (see
    // _startSettling). A zone that was already genuinely occupied (not just settling) has
    // no settle promise, so a truly-busy-zone entry still resolves immediately as before.
    const settlePromises = subEntries.map((sub) => this._settling.get(sub.zone)?.promise).filter(Boolean);
    if (settlePromises.length > 0) {
      await Promise.all(settlePromises);
    }

    await Promise.all(
      subEntries.map(async (sub) => {
        if (sub._admissionPromise) {
          await sub._admissionPromise;
        } else {
          sub.wasQueued = true;
        }
      })
    );

    return { fired: subEntries.every((sub) => sub.status === 'fired') };
  }

  /**
   * Builds this zone's own independent sub-entry for a (possibly multi-zone) enqueue()
   * call. A single-zone entry keeps its caller-supplied id verbatim (it's the N=1 case of
   * decomposition, indistinguishable from today's single-zone handling); only a genuinely
   * multi-zone entry namespaces each zone's sub-entry id, since there are now several
   * independent per-zone records that need distinct identities.
   */
  _buildZoneEntry(entry, zone) {
    const details = entry.zoneDetails?.[zone];
    return {
      id: entry.zones.length > 1 ? `${entry.id}:${zone}` : entry.id,
      parentId: entry.id,
      scheduleId: entry.scheduleId,
      dedupeKey: entry.dedupeKey,
      zone,
      zones: [zone], // kept for _emit/getState/log-format compatibility - always single-element now
      cueNumber: details?.cueNumber ?? entry.cueNumber,
      qlabInternalId: details?.qlabInternalId ?? entry.qlabInternalId,
      durationSeconds: details?.durationSeconds ?? entry.durationSeconds,
      dueAt: entry.dueAt,
      name: entry.name,
      source: entry.source
    };
  }

  /**
   * Called when the OSC layer receives a `/update/.../cue_id/{uniqueId}` push for a
   * uniqueId this engine currently has CONFIRMED occupying a zone - confirms via a live
   * isRunning query and frees the zone early if QLab reports it actually stopped, rather
   * than waiting out the fallback duration timer. Deliberately ignores zones whose occupant
   * is still mid-admission (reserved but not yet confirmed) - that entry's own
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
   * Clears occupancy (confirmed or still-reserving, including a synthetic in-progress-unduck
   * marker - see _maybeUnduck) and drops every waiting entry for the given zones outright -
   * no requeue. Used by vogInterruptHandler once VOG actually stops other cues; the caller
   * is responsible for issuing the real OSC stop, this only clears bookkeeping so admission
   * isn't left blocked on a zone VOG just silenced.
   */
  preemptZones(zoneNames) {
    for (const zone of zoneNames) {
      const occ = this._occupancy.get(zone);
      if (occ) {
        if (occ.timer) this._clearTimer(occ.timer);
        // A reserved-but-not-yet-confirmed occupant (mid-admission - see _tryAdvance/
        // _confirmClearAndFire) has its own confirm-retry chain already running
        // independently and asynchronously. Clearing the occupancy map entry here doesn't
        // stop that chain - without this flag it would complete obliviously and call
        // _fire() anyway, physically playing into a zone this exact preempt just claimed
        // for something else. _confirmClearAndFire checks this flag before ever calling
        // _fire(). A synthetic unduck-wait marker (occ.entry.qlabInternalId === null) has
        // no such chain to stop - clearing the map entry alone is enough, its own pending
        // .finally() harmlessly no-ops (see _maybeUnduck).
        if (occ.entry) occ.entry._preempted = true;
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

  /**
   * Marks zones as already ducked without firing the duck transition itself - used by
   * vogInterruptHandler, which ducks immediately and directly (bypassing the settle window
   * entirely, given VOG's urgency) rather than through the normal admission path this
   * engine drives duck from. Keeps exactly one unduck DECISION path (_isZoneFullyIdle,
   * checked from _freeZone/_startSettling) while letting VOG own duck's own timing.
   */
  markDucked(zoneNames) {
    for (const zone of zoneNames) {
      this._ducked.add(zone);
    }
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
        id: entry.id ?? null,
        scheduleId: entry.scheduleId ?? null,
        cueNumber: entry.cueNumber ?? null,
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
   * FIFO by due time, but two entries due within the same wall-clock second (in the SAME
   * zone) are treated as a genuine tie (rather than whichever happened to reach enqueue() a
   * few ms first, which in practice just reflected cron-plus's internal job-processing
   * order, not anything an operator controls) and broken by cue number ascending instead -
   * lower cue number plays first. Falls back to entry id if cue numbers are equal or
   * non-numeric.
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

  _dropStaleDuplicates(zone, dedupeKey, exceptEntryId) {
    const queue = this._queues.get(zone) || [];
    const stale = queue.filter((e) => e.dedupeKey === dedupeKey && e.id !== exceptEntryId);
    if (stale.length === 0) return;
    this._queues.set(
      zone,
      queue.filter((e) => !stale.includes(e))
    );
    for (const entry of stale) {
      this._emit('dropped_stale', entry, { zone });
    }
  }

  _enforceCap(zone) {
    let queue = this._queues.get(zone) || [];
    while (queue.length > this._maxQueueLength) {
      const oldest = queue[0];
      queue = queue.slice(1);
      this._queues.set(zone, queue);
      this._emit('queue_overflow_dropped', oldest, { zone });
    }
  }

  /**
   * Starts (or continues) settle windows for any newly-contestable zone, then admits the
   * front entry of any zone that's free and past its settle window (synchronously, so
   * nothing else can be picked for that zone), letting each candidate's own duck-wait/
   * confirm-and-fire chain run independently and asynchronously - a slow duck-wait/confirm
   * on one zone never blocks admission on another. Since every entry now belongs to exactly
   * one zone (see the class-level comment), "the front entry" is always the right one to
   * try - there is no cross-zone readiness to check anymore.
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
      if (this._occupancy.has(zone) || this._settling.has(zone)) continue;

      if (this._admissionSettleMs > 0 && !this._settled.has(zone)) {
        this._startSettling(zone);
        continue;
      }

      const candidate = queue.shift();
      // This zone transitioning from unoccupied to occupied is the single, reliable
      // chokepoint for "a burst just started here" - remember it so _beginAdmission awaits
      // this zone's duck cue BEFORE the candidate's own confirm-and-fire chain (see
      // _maybeUnduck for the matching batched-unduck half of this).
      if (!this._ducked.has(zone)) {
        this._ducked.add(zone);
        candidate._freshDuck = true;
      }
      this._occupancy.set(zone, { entry: candidate, expectedEndAt: null, timer: null, confirmed: false });
      // A fresh admission just happened - next time this zone frees, it's a new contest
      // and should get its own settle window again.
      this._settled.delete(zone);
      candidate._admissionPromise = this._beginAdmission(candidate);
    }
  }

  /** Awaits the caller-supplied onZoneTransition hook, tolerating a throw/rejection. */
  async _fireZoneTransition(kind, zone) {
    try {
      await this._onZoneTransition(kind, zone);
    } catch {
      // best-effort - a failing hook must never break the engine's own admission/free
      // state machine.
    }
  }

  /**
   * True only when a zone is genuinely, durably idle right now - no occupant, nothing
   * waiting, and not mid-settle-window for a sibling that might still be admitted (see
   * _startSettling). Checked from the two places a transition to idle could have just
   * completed: _freeZone (after its own _tryAdvance() may have re-admitted a waiting
   * sibling) and _startSettling's timer callback (after ITS _tryAdvance() call) - never
   * from preemptZones, which intentionally leaves unduck to whoever re-ducks the zone next
   * (VOG owns its own zone's ducking state for the VOG's own duration - see markDucked).
   */
  _isZoneFullyIdle(zone) {
    return (
      !this._occupancy.has(zone) &&
      (this._queues.get(zone) || []).length === 0 &&
      !this._settling.has(zone)
    );
  }

  /**
   * Zone genuinely idle and still marked ducked - reserve it with a synthetic occupancy
   * entry (so nothing new can be admitted while unduck plays, and a genuinely back-to-back
   * arrival just queues behind it instead of racing in), fire+await the zone's unduck cue,
   * then release the reservation and re-run _tryAdvance to pick up anything that queued
   * during the wait. Not awaited by callers (_freeZone/_startSettling fire it and move on) -
   * the synthetic reservation is what actually protects the zone in the meantime, not the
   * caller waiting around.
   */
  _maybeUnduck(zone) {
    if (!this._ducked.has(zone) || !this._isZoneFullyIdle(zone)) return;

    this._ducked.delete(zone);
    const unduckEntry = { id: null, cueNumber: null, name: 'Unducking', zones: [zone], qlabInternalId: null };
    const unduckMarker = { entry: unduckEntry, expectedEndAt: null, timer: null, confirmed: true };
    this._occupancy.set(zone, unduckMarker);
    this._emit('unduck_wait', unduckEntry, { zone });

    this._fireZoneTransition('unduck', zone).finally(() => {
      // Only clear if this exact marker is still there - a preempt (or, in principle,
      // anything else) may have already reclaimed the zone while the unduck wait was in
      // flight, in which case there's nothing of ours left to release.
      if (this._occupancy.get(zone) === unduckMarker) {
        this._occupancy.delete(zone);
      }
      this._tryAdvance();
    });
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
      this._tryAdvance(); // may admit a candidate into this zone now, setting its _admissionPromise synchronously
      // The settle window closing is the OTHER moment a zone could resolve to "genuinely
      // idle" (e.g. everything that arrived during it got stale-dropped or preempted) -
      // _tryAdvance() above already re-admitted anything ready, so this only unducks if
      // nothing was.
      this._maybeUnduck(zone);
      resolveSettled();
    }, this._admissionSettleMs);
    this._settling.set(zone, { timer, promise, resolveSettled });
  }

  /**
   * Zone(s) already reserved synchronously by _tryAdvance. If this entry's zone just got a
   * fresh duck (see _tryAdvance), await that zone's duck cue completing FIRST - the message
   * cue genuinely waits for duck to finish, not just an overlapping side effect - before
   * ever starting the confirm-before-fire chain.
   */
  async _beginAdmission(entry) {
    if (entry._freshDuck) {
      this._emit('duck_wait', entry, { zones: [entry.zone] });
      await this._fireZoneTransition('duck', entry.zone);

      // A VOG preempt could have reclaimed this entry's zone while the duck-wait was in
      // flight - same discipline as _confirmClearAndFire's own preempt checks.
      if (entry._preempted) {
        this._emit('preempted_before_fire', entry);
        return;
      }
    }

    await this._confirmClearAndFire(entry, 0);
  }

  async _confirmClearAndFire(entry, attempt) {
    // A VOG trigger's preemptZones() may have reclaimed this entry's zone while this
    // confirm-retry chain was already in flight (reserved before the preempt ran) - see the
    // comment on preemptZones. Check both before doing any more waiting and again right
    // before actually firing, since preemption can land at any point during the await below.
    if (entry._preempted) {
      this._emit('preempted_before_fire', entry);
      return;
    }

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

    if (entry._preempted) {
      this._emit('preempted_before_fire', entry);
      return;
    }

    this._fire(entry);
  }

  _delay(ms) {
    return new Promise((resolve) => this._setTimer(resolve, ms));
  }

  /**
   * Fires a single entry into its one zone (or, for a zero-zone entry - no `entry.zone` at
   * all - fires with no occupancy tracking whatsoever, since there's nothing to collide
   * over). A zero-zone entry still goes through the confirm-before-fire chain above it
   * (_confirmClearAndFire), it just never claims a zone here.
   */
  _fire(entry) {
    if (entry.zone) {
      const durationSeconds = entry.durationSeconds ?? this._fallbackDurationSeconds;
      const durationMs = durationSeconds * 1000;
      const expectedEndAt = this._clock() + durationMs;
      const timer = this._setTimer(() => this._freeZone(entry.zone, entry), durationMs);
      this._occupancy.set(entry.zone, { entry, expectedEndAt, timer, confirmed: true });
    }

    entry.status = 'fired';
    this._emit('fired', entry, { afterQueue: entry.wasQueued === true });
    Promise.resolve(this._protocol.playCue(entry.cueNumber)).catch((err) => {
      // The zone was already claimed for the cue's full assumed duration the moment we
      // decided to fire (see the occupancy.set above) - if the actual OSC /start came back
      // denied (e.g. OSC control permissions off, or the cue was deleted/renamed in QLab
      // between the cue_cache refresh and this fire) or otherwise failed, nothing ever
      // actually played, so holding the zone hostage for the rest of that duration window
      // would be pure waste. Free it immediately instead of waiting out the timer.
      this._emit('error', entry, { message: err.message });
      if (!entry.zone) return;
      const occ = this._occupancy.get(entry.zone);
      if (occ && occ.entry === entry) {
        this._clearTimer(occ.timer);
        this._freeZone(entry.zone, entry, 'start_failed_zone_freed');
      }
    });
  }

  _freeZone(zone, entry, eventName = 'zone_freed') {
    const occ = this._occupancy.get(zone);
    if (!occ || occ.entry !== entry) return;
    this._occupancy.delete(zone);
    this._emit(eventName, entry, { zone });
    // _tryAdvance() may immediately re-admit a waiting sibling into this same zone (the
    // back-to-back case) - only unduck once it's had that chance and genuinely found
    // nothing, so consecutive queued messages duck once and unduck once, not per-message.
    this._tryAdvance();
    this._maybeUnduck(zone);
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
