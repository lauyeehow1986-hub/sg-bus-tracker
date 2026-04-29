# SG Bus Tracker

A self-hosted Singapore bus tracker that runs on your Android phone via
Termux. No cloud, no servers, no monthly fees — just your phone, the LTA
DataMall API, and Chrome.

Built for personal use as a faster alternative to commercial bus apps,
with features oriented around real Singapore commute scenarios.

![Status: v10.12 — actively used in daily commutes](https://img.shields.io/badge/status-v10.12_daily_use-brightgreen)
![Platform: Android via Termux + Chrome PWA](https://img.shields.io/badge/platform-Android_(Termux_%2B_Chrome_PWA)-blue)
![License: MIT](https://img.shields.io/badge/license-MIT-lightgrey)

---

## What it does

**Real-time bus arrivals** for any stop in Singapore.

**Journey planning** with both direct and 1-transfer options surfaced
side-by-side, like Google Maps' transit view. Includes an MRT hint
when both endpoints are within ~400m of an MRT/LRT station.

**Live "you are here" tracking** on the route list while you're on the
bus. The marker advances forward through the stop sequence using
direction-of-travel inference, so it shows the upcoming stop, not the
one you've passed.

**Auto-direction-switch** — open the route panel and within ~30 seconds
the app figures out which direction you're travelling and switches
the tab automatically.

**Alighting alarm** with vibration, audio chime, spoken stop name, and
system notification at 250m and 80m thresholds. Plus per-stop progress
announcements: "Just passed Bedok Sports Cplx. 8 stops to go." Screen
wake-lock keeps the display alive during the journey.

**MRT real-time crowding dots** (green / amber / red) on every route
that passes near an MRT station. Live disruption banner when LTA reports
service alerts.

**First/last bus timings** on every service card, with day-type
awareness (weekday / Saturday / Sunday).

**Nearby stops** with all stops within 600m, sorted by distance.

**Offline-capable** — service worker caches the app shell. Works without
data once arrivals have loaded.

## Why this exists instead of using a commercial bus app

- **Speed.** Loads in ~200ms. Commercial apps load in 3–5 seconds.
- **No ads.** None.
- **No tracking.** Your LTA API key, location, and journey history stay
  on your device.
- **Free in the long run.** No subscription, no in-app purchases. The
  LTA DataMall API is free.
- **Customisable.** It's your code. Change the algorithms, tune the
  thresholds, add features. See `docs/changelog/` for examples.

## Why NOT this

- **Setup is involved.** ~25 minutes of one-time configuration including
  Termux, F-Droid, OEM battery whitelisting. Not for non-technical users.
- **Foreground-only alarm.** The alighting alarm needs the app open and
  screen on. PWAs can't reliably run with phone locked. If you want
  pocket-the-phone reliability, use [SG BusLeh](https://busleh.com/).
- **Singapore only.** Hardcoded to LTA DataMall.
- **Android only.** iOS doesn't allow Termux.

## Architecture

```
┌─────────────┐         ┌──────────────────┐        ┌──────────────────┐
│ Chrome PWA  │ ──────▶ │ Python proxy     │ ─────▶ │ LTA DataMall API │
│ (the app)   │ ◀────── │ on localhost:8080│ ◀───── │                  │
└─────────────┘         └──────────────────┘        └──────────────────┘
       │                          │
       │                          ├── Manages your API key
       │                          ├── Handles CORS for Chrome
       │                          └── Auto-restarts on crash
       │
       └── Service worker caches everything for offline use
       └── Auto-installable as a home-screen app
```

The Python proxy (`proxy.py`) runs as a Termux foreground service
managed by Termux:Boot. It restarts automatically on phone reboot.

## Quick deploy (for someone who already has Termux)

```bash
# In Termux:
cd ~
git clone https://github.com/lauyeehow1986-hub/sg-bus-tracker.git
cd sg-bus-tracker
chmod +x scripts/*.sh
bash scripts/start.sh

# Configure auto-start:
mkdir -p ~/.termux/boot
ln -sf ~/sg-bus-tracker/scripts/termux-boot-start.sh ~/.termux/boot/sg-bus-tracker
chmod +x ~/.termux/boot/sg-bus-tracker
```

Then in Chrome on the phone: <http://127.0.0.1:8080/index.html>, paste
your LTA DataMall API key, done.

For the comprehensive guide (Termux/F-Droid install, OEM battery
whitelist, location permissions, troubleshooting), see
**[docs/SETUP.md](docs/SETUP.md)**.

## Get an LTA DataMall API key (free)

<https://datamall.lta.gov.sg/content/datamall/en/request-for-api.html>

Takes 2 minutes; the key arrives by email almost immediately.

## Tech stack

- **Frontend**: vanilla ES6 modules, no build step. ~5500 lines of JS
  across 16 files. Mobile-first CSS in a single stylesheet.
- **Map**: Leaflet 1.9 with OpenStreetMap tiles
- **Proxy**: Python 3 stdlib only (`http.server`, no Flask / FastAPI).
  ~400 lines.
- **Data**: bus stops fetched from LTA at runtime, MRT stations
  precomputed via OneMap Search API into `data/stations.json`
- **PWA**: service worker with versioned cache eviction, manifest for
  home-screen install
- **No dependencies on npm or pip.** Termux's bundled `python` package
  is sufficient.

## Project structure

```
sg-bus-tracker/
├── index.html          # Single-page app shell
├── manifest.json       # PWA manifest
├── sw.js               # Service worker
├── proxy.py            # Python proxy + key manager + log endpoint
├── icon-192.svg        # PWA icons
├── icon-512.svg
├── css/styles.css      # All UI styles
├── js/                 # ES6 modules
│   ├── app.js          # Bootstrap, search, nearby stops
│   ├── route.js        # Route panel + map + alarm wiring
│   ├── liveLocation.js # GPS-based stop highlighting + auto-switch
│   ├── alarm.js        # Alighting alarm with TTS + chime + vibration
│   ├── planner.js      # Journey planner with transfers
│   ├── mrtHint.js      # MRT alternative suggestion
│   ├── train.js        # Train alerts + crowding dots
│   ├── stations.js     # MRT station proximity matching
│   ├── stops.js        # Stop search index + matching
│   ├── timing.js       # First/last bus formatting
│   ├── search.js       # Stop search UI
│   ├── pwa.js          # Service worker registration + cache eviction
│   ├── toast.js        # Toast notifications
│   ├── dom.js          # Tiny DOM helpers
│   ├── log.js          # In-page log viewer
│   ├── state.js        # Module-level shared state
│   └── api.js          # API call wrappers
├── data/
│   └── stations.json   # MRT/LRT station coords + line codes
├── scripts/
│   ├── start.sh        # Start the proxy
│   ├── stop.sh         # Stop the proxy
│   ├── status.sh       # Health check
│   ├── check.sh        # Lint JS / Python / JSON
│   ├── termux-boot-start.sh  # Auto-start hook
│   └── build-stations.sh     # Build full MRT dataset via OneMap
└── docs/
    ├── SETUP.md        # Comprehensive setup guide (this is what you want)
    └── changelog/      # Per-version patch notes (v9.1 to v10.12)
```

## Versioning and changelog

Each user-facing change ships as a versioned patch with detailed notes
in `docs/changelog/`. The current version is **v10.12**. The cache key
in `sw.js` is bumped on every release; old caches are auto-evicted.

Key milestones:

- **v9** — MRT crowding dots, train service alerts banner
- **v10** — MRT journey hint in planner
- **v10.1** — always show transfer alternatives
- **v10.2** — live position on route list
- **v10.3** — auto-direction-switch
- **v10.4** — user marker on route map
- **v10.5–v10.7** — fixes for the live marker (between-stops, after
  passed stops, mid-route boarding)
- **v10.8–v10.10** — search and nearby fixes
- **v10.11** — alighting alarm
- **v10.12** — per-stop announcements + hidden-tab robustness

Full notes in [`docs/changelog/`](docs/changelog/).

## Contributing

This is a personal project hosted publicly so others can learn from it
or fork it. I'm not actively soliciting contributions. If you find a
bug or have a Singapore-specific suggestion, file an issue and I'll
look at it when I can.

If you want to fork and modify for a different city's transit system,
the `proxy.py` API forwarder and the `liveLocation.js` direction
inference logic are the most reusable pieces. The rest is fairly tied
to LTA DataMall's data shape.

## License

MIT. See [LICENSE](LICENSE).

Bus stop and route data come from
[LTA DataMall](https://datamall.lta.gov.sg/) — usage subject to their
terms. MRT station coordinates come from
[OneMap](https://www.onemap.gov.sg/) public Search API.

Map tiles by [OpenStreetMap](https://www.openstreetmap.org/)
contributors, displayed via [Leaflet](https://leafletjs.com/).

Not affiliated with LTA, OneMap, or Anthropic. Personal project, built
with assistance from Claude.
