# QLab Scheduled Audio Messaging System — Project Brief

## Objective

Build a reliable scheduling layer for QLab that allows operators to schedule recurring audio messages without creating each playback event manually.

The system must support rules such as:

* Play an audio message every X minutes or seconds
* Restrict playback to defined start and end times
* Select active weekdays and date ranges
* Enable, disable, test and edit schedules through a simple GUI
* Trigger QLab cues assigned to specific audio zones

## Proposed Architecture

QLab remains the primary playback and audio-routing engine. Node-RED provides scheduling, configuration, logging and system monitoring.

```text
Operator Web Dashboard
        │
        ▼
Node-RED
├── Schedule database
├── Schedule validation and compilation
├── Cron-plus scheduling engine
├── Collision and priority handling
├── Event logging
└── QLab health monitoring
        │
        ▼ OSC
QLab
├── Audio files
├── Group and Audio cues
├── Zone routing
├── Ducking and fades
└── Multi-channel audio interface
```

## Core Components

**QLab**
Handles audio playback, cue logic, fades, ducking and routing to individual channels or zones on the audio interface.

**Node-RED**
Runs the scheduling application, business logic and communication with QLab.

**Cron-plus**
Executes recurring and time-based schedules. Operator-friendly rules are converted internally into cron expressions or sequences of exact timestamps.

**FlowFuse Dashboard**
Provides a browser-based operator interface for adding, editing, enabling, disabling and testing schedules. Operators do not interact directly with cron expressions or the Node-RED flow editor.

**Schedule Database**
Stores the authoritative schedule configuration, including cue name, interval, active hours, weekdays, date range, priority and overlap policy. SQLite is recommended for the production system.

**OSC Integration**
Node-RED triggers QLab cues using stable, human-readable cue numbers such as:

```text
MSG.LOBBY.SAFETY
MSG.GALLERY.CLOSING
MSG.ALL.EMERGENCY
```

QLab may also send confirmation messages back to Node-RED so the Dashboard can display playback status and detect failures.

## Operator Interface

The Dashboard should provide:

* Schedule list with enabled status
* Message and QLab cue selection
* Repeat interval
* Start and end times
* Weekday and date-range controls
* Next scheduled playback time
* Play-now testing
* Event history
* QLab connection status
* Overlap options such as skip, queue or interrupt

## Deployment

For a single playback system, Node-RED should run on the same Mac as QLab.

This allows OSC communication over localhost, reduces network dependencies and simplifies startup, backup and maintenance. The Dashboard can still be accessed remotely from an authorized browser or tablet.

Node-RED and QLab should start automatically with the Mac. Scheduling should remain inactive until Node-RED confirms that the correct QLab workspace is open and responding.

## Design Principles

* QLab owns all media, audio processing and zone routing.
* Node-RED owns timing, schedule configuration and logging.
* Operators use only the Dashboard.
* Cron-plus remains an internal scheduling engine.
* Schedule records remain persistent across restarts.
* Missed repeating events are skipped rather than replayed in bulk.
* Playback conflicts are handled through configurable priority and overlap rules.

## Expected Outcome

The completed system will retain QLab’s polished playback and routing environment while adding a purpose-built scheduling interface suitable for frequent, repeating, multi-zone audio messaging.
