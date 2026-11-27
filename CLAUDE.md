# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`iobroker.digitalstrom` is an ioBroker adapter for digitalSTROM installations. It talks to the
**digitalSTROM Server (dSS)** over two interfaces and mirrors the apartment (zones, groups,
devices, circuits, scenes, sensors, outputs, temperature control) into ioBroker states:

- the **classic JSON API** (`/json/...`, session based, event long-polling) - structure, scenes,
  sensor values, binary inputs, button presses, metering
- the **Smart Home API** (`/api/v1`, dSS firmware 1.19 and newer) - output values of all devices
  in one request, plus a notification websocket that reports changes made outside ioBroker.
  Optional (`native.useSmartHomeApi`). See `docs/smarthome-api.md` for what a real dSS answers.

Both interfaces use the same app token (`native.appToken`), created from the admin dialog via
`sendTo` (`createAppToken`, `createSmartHomeKey`).

TypeScript (CommonJS output). Sources live in `src/`, the published/runnable code is the compiled
`build/` (`package.json` `main` is `build/main.js`). The admin interface is a React app in
`src-admin/`, built by vite into `admin/index.html` + `admin/assets/`. Both outputs are
gitignored - always run the build before starting the adapter or the tests.

## Commands

```bash
npm run build                             # tsx tasks.ts: backend (tsc -> build/) and admin (vite -> admin/)
npm run build:backend                     # backend only
npm run build:admin                       # admin interface only
npm run watch                             # backend in watch mode
npm run dev:admin                         # vite dev server for the admin dialog (preview.html)
npm run check                             # type check: tsconfig.json (src/, tasks.ts) and src-admin/tsconfig.json
npm run lint                              # eslint (@iobroker/eslint-config, flat config)
npx eslint -c eslint.config.mjs --fix src # autofix + prettier formatting

npm run test:unit                         # mocha unit tests in test/test*.js - need a build first
npm run test:package                      # validates package.json / io-package.json (fast)
npm run test:integration                  # starts a real js-controller + adapter instance
npx mocha --require test/mocha.setup.js test/testQueue.js --grep "supersede"   # single test
npm run release-patch                     # @alcalzone/release-script, moves README changelog into io-package news
```

There is deliberately **no `prepare` script** - `npm ci`/`npm install` does not build. Because
neither `build/` nor the admin bundle is committed, `common.nogit` is `true` in `io-package.json`:
the adapter can only be installed from npm, not from GitHub. The integration test requires that
**no** js-controller is running on the machine.

## Architecture

| Path | Content |
| --- | --- |
| `src/main.ts` | the adapter: `Digitalstrom extends utils.Adapter` - startup, config normalization, `sendTo` handlers, event handling, polling, restart/retry logic |
| `src/lib/dss.ts` | `DSS` - HTTP(S) client of the classic JSON API: session handling, request retry, event subscriptions and long-polls |
| `src/lib/dssQueue.ts` | `DSSQueue` - serializes writes to the dSS; a newer value for the same target supersedes a queued one (`SupersededError`) |
| `src/lib/dssStructure.ts` | `DSSStructure` - builds the object tree from `apartment/getStructure`, keeps `stateMap` (dSS key -> state id), translates events and values both ways, metering |
| `src/lib/dssSmartHome.ts` | `DSSSmartHome` - client of the Smart Home API and its notification websocket |
| `src/lib/dssSmartHomeSync.ts` | `SmartHomeOutputSync` - reads all output values through one apartment status request and reconciles states changed outside ioBroker |
| `src/lib/websocket.ts` | `MiniWebsocket` - minimal RFC 6455 client for the notification endpoint (no runtime dependency) |
| `src/lib/activityCounter.ts` | sliding-window request/event counters shown in the status tab |
| `src/lib/configUtils.ts` | `normalizeBoolean()` for config values, `errorMessage()`/`asError()`, types `AdapterError`, `DssResponse` |
| `src/lib/constants.ts` | fixed digitalSTROM tables: event names, roles of sensors and output channels, scene names and values |
| `src/lib/adapter-config.d.ts` | types `this.config` from `native` in `io-package.json` (derived, nothing to maintain) |
| `src/lib/apollon-iobroker-tools.d.ts` | types for `@apollon/iobroker-tools` (objectHelper), which ships none |
| `src-admin/` | React admin dialog (`App.jsx`, `Settings.jsx`, `objectsWarnLimit.js`), translations in `src-admin/src/i18n/*.json` |
| `tasks.ts` | build tasks (clean, tsc, vite via `@iobroker/build-tools`) |

Details that bite:

- **Credentials:** `appToken` and `smartHomeApiKey` are in `encryptedNative`/`protectedNative`.
  2.3.0 stored the token in plain text; `migratePlainTextSecrets()` in `main.ts` re-encrypts it on
  start and restarts the instance once. Do not add `encryptedFields` in the admin app as well -
  the value would be decrypted twice.
- **Rate limits of the dSS:** polling defaults to 100 s per cycle (`DEFAULT_POLL_INTERVAL`);
  smaller values exceed the digitalSTROM guidelines and are documented as such.
- **Objects:** created through the objectHelper of `@apollon/iobroker-tools`. The helper keeps its
  state in module scope, so `Digitalstrom.createObjectHelper()` loads a private copy per instance
  (compact mode runs several instances in one process).
- **Compact mode:** `main.ts` exports a factory with the class attached (`factory.Digitalstrom`);
  the unit tests use that class with a fake `this`, so methods that use `this.setTimeout` & co.
  need those functions on the fake context.
- The dSS sends names with HTML entities (`&amp;`), which are decoded everywhere.
- Lib classes use Node's timers and clear them in their own stop/close methods; the adapter class
  uses the adapter-core timers.

## Tests

- `test/test*.js` are plain JS mocha tests against the compiled `build/` (and `src-admin/` for the
  admin dialog logic). Assertions use `node:assert` and `sinon.assert`, no chai.
  `test/lib/` holds a mock dSS (classic and Smart Home API), a fake admin socket and helpers.
- `test/packageFiles.js` and `test/integrationAdapter.js` are the standard `@iobroker/testing` suites.
- CI (`.github/workflows/test-and-release.yml`) uses `ioBroker/testing-action-check@v2`,
  `-adapter@v1` (with `build: true`, runs `test:unit` and `test:integration`) and `-deploy@v1`
  (npm trusted publishing, Sentry release).

## Conventions

- Translate, don't redesign: object ids, roles, `native` field names, `sendTo` commands and defaults
  must stay stable - existing installations depend on them.
- Every change gets a line under `### **WORK IN PROGRESS**` in `README.md` (English) and
  `README_de.md` (German).
- Comments explain *why*, often with the measurement on a real dSS that led to a decision - keep them.
