# 06 · Development

## Repo layout

```
lib/            Plain, testable JS business logic — no Node-RED coupling except at the edges
node-red/       Headless Node-RED userDir: flows.json + settings.js + thin handler wrappers
webapp/         FastAPI operator UI (Python)
config/         audio-patch-map.json (the one manual config) + env.example
data/           SQLite database (gitignored, created by the migration runner)
logs/           app-*.log + events-*.log (gitignored, 30-day rotation)
scripts/        One-off spikes and seed helpers
test/           Jest unit tests (mirrors lib/) + fixtures + the integration checklist
deploy/         launchd LaunchAgent plists (see chapter 07)
docs/           This documentation
```

## `lib/` module map

All non-trivial logic lives here so it's unit-testable in isolation.
[`lib/index.js`](../lib/index.js) is the **composition root**: `createCore(config)` wires the
modules together, and Node-RED exposes that facade via `functionGlobalContext` (`settings.js`).

| Module | Responsibility |
|---|---|
| `osc/oscClient.js` | Raw UDP transport, request/response correlation, timeouts |
| `osc/qlabProtocol.js` | QLab verbs: duration, levels/patch, play/stop, list cues, `/updates`, `/thump` |
| `zones/zoneResolver.js` | Derive a cue's zones (+ per-zone cue/duration) from its Audio Patch |
| `zones/audioPatchMap.js` | Load/validate `config/audio-patch-map.json` |
| `zones/duckDuration.js` | Play a duck/unduck cue and wait out its real duration |
| `scheduling/scheduleModel.js` | Pure schedule validation/normalization (the write authority) |
| `scheduling/occurrenceCalculator.js` | Next-occurrence math + cron-plus job spec (DST-safe) |
| `scheduling/cronSync.js` | Diff SQLite schedules vs. cron-plus jobs |
| `queue/zoneQueueEngine.js` | Per-zone FIFO, confirm-before-fire, ducking, VOG preempt |
| `vog/vogInterruptHandler.js` | Resolve VOG zone scope, stop occupants, fire the VOG cue |
| `health/healthMonitor.js` | Heartbeat state machine + the scheduler arm gate |
| `log/{appLogger,eventLogger}.js` | The two rotating logs |
| `db/…` | `database.js`, `migrations/`, `repositories/{schedules,vogMessages,cueCache}Repo.js` |

Node-RED Function nodes stay thin: the logic-bearing ones delegate to
[`node-red/lib/handlers/`](../node-red/lib/handlers) (one module per domain — schedules, vog, cues,
zones, startup), each a `(msg, node) => result` function closing over the injected `core`. The
webapp mirrors this shape under [`webapp/app/`](../webapp/app): `routers/` (pages + `/api/*`),
`models/` (Pydantic), `db/queries.py` (read-only), `node_red_client.py` (the one proxy client).

## Running locally

Prerequisites: Node (v26/npm 11 on the dev machine) and Python 3.12, plus a running QLab with OSC
control enabled (Workspace Settings → Network → OSC Controls, read/edit/control, no passcode).

```bash
# install
npm install
python3 -m venv webapp/.venv && webapp/.venv/bin/pip install -r webapp/requirements-dev.txt

# run the engine (headless Node-RED)
npm run node-red

# run the webapp (from webapp/, with the venv active)
cd webapp && .venv/bin/uvicorn app.main:app --reload
```

Then open `http://127.0.0.1:8000`. For unattended/production run-under-launchd, see
[07 · Deployment & operations](07-deployment-operations.md).

## Tests

```bash
npm test                 # Jest — lib/ + node-red/ handlers (test/unit/**)
cd webapp && pytest      # FastAPI — queries, node_red_client (respx), models, routers, pollers
```

Tests are run manually — there is no CI. `test/integration/INTEGRATION_CHECKLIST.md` is the
hands-on checklist against real QLab (things unit tests can't cover: OSC permissions, real
collisions, health disarm/rearm, restart correctness).

## Tooling

- **JS:** ESLint (flat config, `eslint.config.js`) + Prettier (`.prettierrc`).
- **Python:** Ruff (lint + format), configured in `webapp/pyproject.toml`.
- **Pre-commit:** Husky + lint-staged run Prettier/ESLint on staged JS and Ruff on staged Python
  (format/lint only — tests are not run in the hook).
- `.git-blame-ignore-revs` keeps the one-time repo-wide reformat out of `git blame`; configure it
  once with `git config blame.ignoreRevsFile .git-blame-ignore-revs`.

```bash
npm run lint            # eslint .
npm run format          # prettier --write
```
