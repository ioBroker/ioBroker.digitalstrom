# Smart Home API paths

The adapter uses the digitalSTROM Smart Home API for two optional bulk reads:

```text
GET /api/v1/apartment/meterings/values   (all meter values, one request)
GET /api/v1/apartment/status             (all device output values, one request)
```

All structure reads, device and zone commands, sensor values, button events and scene events continue
to use the classic dSS JSON API. In addition the adapter starts the notification websocket of the new
API (see below); the other methods implemented by the client are not used.

## Output values

With the option enabled, the initial output reads at startup and the re-reads after a scene call are
served by ONE apartment status request instead of one classic read per output channel. Triggers are
collected for two seconds, so a room scene across many devices still costs a single request.

The status delivers each output already in the scale the ioBroker states use: the API normalizes every
channel to its official value range (brightness 0..100, colortemp 0..1000, ...), which is exactly the
`classic * max / nativeMax` conversion of the classic read callbacks. Values are rounded to whole
numbers like before, and the brightness of a light goes through the same helper that maintains the
boolean `.state` including the switch threshold.

Rules learned from live measurements against a real dSS:

- An output that is currently moving carries NO `value` field in the status. Missing means
  "unchanged", never null. The channel is asked again after 15 seconds, up to four times - after that
  the classic read delivers whatever it can.
- Boolean output channels (`airLouverAuto`, `airFlowAuto`) stay on the classic read; their 0/1
  representation in the new API is not verified.
- A failed status request falls back to the classic reads immediately and pauses the Smart Home reads
  for five minutes.

## Notification websocket

The websocket carries no payload - every notification only says THAT something changed, and one
fires for every meter tick (measured: 17 in 75 seconds). Buttons and scenes are already reported
precisely by the classic events, so the adapter reacts with a hard rate limit: at most every five
minutes a notification triggers one reconciliation of all output values through the usual status
request. That catches changes made past ioBroker - for example a third-party app writing an output
directly - without adding steady load. The channel pings silent connections, reconnects on its own,
and a dSS that does not offer it leaves the adapter running exactly like before.

## Zone temperature and scene names

Every status answer also carries the room temperature control of each zone. The adapter takes over
`setpoint` (°C) and `controlValue` (%) for the existing `sensors.NominalValue` and
`sensors.ControlValue` states - verified value-identical against a real installation. The operation
mode strings stay with the classic path, their numeric mapping is not verified.

At startup one request to `/api/v1/apartment/scenarios` loads the scene names the user gave in
digitalSTROM. They fill the gaps the classic `getReachableScenes` naming leaves; where the classic
answer already delivers a name, that name wins unchanged.

## Requirements and activation

- dSS firmware 1.19 or newer
- optionally an application API key for the Smart Home API - without one, the adapter uses the login
  of the classic interface for the new API and the notification websocket
- **Read meter values through the new API** enabled in the adapter settings

The button in the settings creates the API key from the existing classic App-Token. The key is stored
as an encrypted and protected native setting. The option is disabled by default. If it is disabled,
meter values use the classic API exactly as before. If it is enabled without a key, the classic session
is used instead; only without both a key and a classic connection the adapter stays on the classic API.

On adapter shutdown, an in-flight key request is aborted locally and any late reply is ignored. An HTTP
abort cannot undo work the dSS may already have completed: if shutdown happens after the server accepted
the creation request but before the adapter received the reply, an unused application token may remain
on the dSS.

## Validation and fallback

One circuit is accepted only when the response contains both a finite power value and a finite energy
value. Numeric strings are converted to numbers. `null`, empty strings, `NaN` and infinite values are
treated as missing.

When only some circuits are incomplete, the adapter performs the two classic reads only for those
circuits. A transport, authentication or schema error falls back to the classic path for all circuits.
The completion status counts the requests that were actually attempted.

After a failed Smart Home request, another optional attempt is delayed by 5, 10, 20, 40 and then at
most 60 minutes. HTTP 401 and 403 start directly with the 60-minute delay. Normal classic polling
continues during the delay. Any usable Smart Home response resets the backoff.

## Energy unit

On the verified dSS20 with firmware 1.19.13 the API labels the cumulative value as `Wh`, but the value
matches the classic watt-second counter. The adapter therefore keeps the classic conversion:

```text
kWh = value / 3600 / 1000
```

This path should remain marked experimental until it has been compared on additional dSS hardware and
firmware versions.

## Which API is working

`info.meteringApi` holds the API that delivered the last meter reading:

| value | meaning |
| --- | --- |
| `smarthome` | every circuit came from the Smart Home API, one request per cycle |
| `classic` | the classic API did the work, either completely or for the circuits the new API left out |

The state changes only when the path changes, so it can be charted without noise. The classic API is
what serves everything else, so as long as devices, scenes and sensors keep updating it is working.

`info.outputApi` does the same for the device output values, with one refinement: single channels the
status structurally never delivers (measured: the outputs of audio devices are missing from the status
entirely - since 2.4.21 the named classic read `device/getOutputChannelValue2` serves them instead -
a switched socket reports its `powerLevel` under the id `powerState` - its `level` field is
0..1, measured live 0 while off and 1 while powering a device, and is scaled to the 0..100 state - and
the class-64 shade values appear only under the `...Outside` ids) are handed to the classic read
WITHOUT flipping the state - the Smart Home API stays in charge of everything else, and the two known id mismatches are
resolved by aliases so those channels are served by the status after all. Channels the status still
never answers are learned after two exhausted follow-up budgets and go to the classic read right away,
without burning ~60 s of follow-ups per trigger; every later status answer that carries such a channel
again heals the learning, and a learned channel is probed through the status once an hour so the
learning cannot latch when no other status traffic runs. `classic` therefore shows while the status
request itself fails, while the sync pauses in its backoff, or when the option is off - plus once per
adapter start on an installation whose outputs are generic devices (hardware that is neither light,
shade nor joker). Their initial read counts for the state: a native terminal reads it through the
channel index it declares itself, vDC hardware through the named channel read. With the Smart Home
API on, a vDC device hands that read to the bundled status request instead, so such an installation
reports `smarthome` as soon as the first value arrives.

`info.connection` is deliberately NOT set by a cycle that only used the Smart Home API: such a cycle
sends no classic request and therefore cannot testify about it. A dSS that is really unreachable still
turns the connection off, because the new API fails as well and the classic fallback reports it.
