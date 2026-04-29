# SG Bus Tracker — Complete Setup Guide

This is the comprehensive walkthrough for getting SG Bus Tracker running
on a fresh Android phone. Total time: ~20–30 minutes, most of it waiting
for downloads.

For a quick overview of the app, see the [main README](../README.md).

---

## Table of contents

1. [What you need before starting](#what-you-need)
2. [Phase A — Install Termux and Termux:Boot](#phase-a)
3. [Phase B — Get an LTA DataMall API key](#phase-b)
4. [Phase C — Install the app](#phase-c)
5. [Phase D — Configure auto-start](#phase-d)
6. [Phase E — First launch and API key entry](#phase-e)
7. [Phase F — Install as a home-screen app](#phase-f)
8. [Phase G — Get the full MRT station dataset](#phase-g)
9. [Phase H — Grant location permission](#phase-h)
10. [Phase I — Notification permission for the alighting alarm](#phase-i)
11. [Daily use](#daily-use)
12. [Troubleshooting](#troubleshooting)
13. [Updating to a newer version](#updating)
14. [Uninstalling](#uninstalling)

---

<a id="what-you-need"></a>
## What you need before starting

- An Android phone (Android 7.0 / Nougat or newer). iOS is not supported
  — the auto-start mechanism relies on Termux which is Android-only.
- The repository contents (clone or zip download).
- ~200 MB free storage (mostly for Termux's Python install).
- A working internet connection.

### Important: do NOT install Termux from Google Play

The Play Store version of Termux is frozen at an old release that does
not accept Termux:Boot. You must install both Termux and Termux:Boot
from F-Droid. Covered in Phase A.

---

<a id="phase-a"></a>
## Phase A — Install Termux and Termux:Boot

### A.1 Install F-Droid

1. On the phone, open Chrome and go to <https://f-droid.org>
2. Tap "Download F-Droid". The `F-Droid.apk` file will download.
3. When prompted, allow Chrome to install unknown apps:
   - Tap "Settings" in the prompt
   - Enable "Allow from this source"
4. Open the downloaded APK and tap "Install".

### A.2 Install Termux from F-Droid

1. Open the F-Droid app. Wait for the initial index update.
2. Search for `Termux` (icon: black terminal prompt). Install.
3. When asked to allow F-Droid to install unknown apps, grant permission.

### A.3 Install Termux:Boot from F-Droid

1. Search for `Termux:Boot` (yes, with the colon). Install.
2. **Open Termux:Boot once after installing.** Critical — Android grants
   it auto-start permission only after first launch. You'll see a short
   info screen. Just close it.

### A.4 First-time Termux setup

1. Open Termux. You'll see a terminal with a `$` prompt.
2. Run these commands one at a time (press Enter after each):

   ```bash
   pkg update -y
   pkg upgrade -y
   pkg install -y python curl jq git
   ```

3. Run:

   ```bash
   termux-setup-storage
   ```

   When Android prompts, grant Termux access to shared storage.

---

<a id="phase-b"></a>
## Phase B — Get an LTA DataMall API key

The app needs an LTA DataMall account key to fetch bus arrivals. Free,
takes 2 minutes.

1. Visit <https://datamall.lta.gov.sg/content/datamall/en/request-for-api.html>
2. Fill in the short form (name, email, intended use — "personal bus
   tracker app" is fine).
3. Submit. You'll get an email with your `AccountKey` — a long
   alphanumeric string.
4. Save the key somewhere you can copy-paste it on the phone later
   (email it to yourself, or use a password manager).

---

<a id="phase-c"></a>
## Phase C — Install the app

### Option 1: Clone from GitHub (recommended)

In Termux:

```bash
cd ~
git clone https://github.com/lauyeehow1986-hub/sg-bus-tracker.git
cd sg-bus-tracker
chmod +x scripts/*.sh
```

Replace `lauyeehow1986-hub` with your GitHub username (or whoever's hosting
the repo).

### Option 2: Download zip

If you have the project as a zip file (e.g. transferred via cloud
storage):

```bash
cd ~
cp ~/storage/downloads/sg-bus-tracker.zip .
unzip sg-bus-tracker.zip
cd sg-bus-tracker     # adjust if folder has different name
chmod +x scripts/*.sh
```

### Why the project must live in Termux's home directory

Android's shared `Downloads/` folder uses a filesystem that silently
ignores the Unix executable bit. Scripts won't run from there. Both
options above place the project under `~/` (Termux's home), which works.

### C.3 Smoke-test the proxy

Verify the proxy runs:

```bash
bash scripts/start.sh
```

Expected output:

```
✓ Proxy started (PID 12345).
  Logs:  tail -f /data/data/com.termux/files/home/.sg-bus-tracker.log
  Stop:  bash /data/data/com.termux/files/home/sg-bus-tracker/scripts/stop.sh
```

Wait ~3 seconds, then check status:

```bash
bash scripts/status.sh
```

Look for `State: RUNNING (PID nnn)` and `127.0.0.1:8080/ping — OK`.

If `ping — OK` appears, the proxy is working. If unreachable, see
[Troubleshooting](#troubleshooting).

---

<a id="phase-d"></a>
## Phase D — Configure auto-start

This makes the app start automatically whenever the phone boots.

In Termux:

```bash
mkdir -p ~/.termux/boot
ln -sf ~/sg-bus-tracker/scripts/termux-boot-start.sh ~/.termux/boot/sg-bus-tracker
chmod +x ~/.termux/boot/sg-bus-tracker
```

### D.1 Whitelist Termux in Android's battery saver

This is where most auto-start failures come from. Android aggressively
kills background apps to save battery.

General steps:

1. Settings → Apps → Termux → Battery → set to **"Unrestricted"** /
   **"No restrictions"**
2. Repeat for **Termux:Boot**

OEM-specific paths:

- **Xiaomi / Redmi**: Settings → Apps → Manage apps → Termux →
  "Autostart" toggle ON. Same for Termux:Boot.
- **Oppo / Realme**: Settings → Battery → Power management → Allow
  background activity for Termux and Termux:Boot.
- **Samsung**: Settings → Apps → Termux → Battery → "Unrestricted".
  Also: Settings → Device care → Battery → Background usage limits →
  Never sleeping apps → add Termux.
- **OnePlus / OxygenOS**: Settings → Battery → Battery optimization →
  Termux → Don't optimize.
- **Huawei**: Settings → Battery → App launch → Termux → Manage manually
  → enable "Auto-launch", "Secondary launch", and "Run in background".

If you skip this, auto-start may silently stop working after Android
"optimises" things.

### D.2 Reboot and verify

Reboot the phone. After Android finishes booting, wait ~15 seconds, then
run in Termux:

```bash
bash ~/sg-bus-tracker/scripts/status.sh
```

You should see `State: RUNNING` with a PID. If not, see
[Troubleshooting](#troubleshooting).

---

<a id="phase-e"></a>
## Phase E — First launch and API key entry

Open Chrome on your phone and go to:

```
http://127.0.0.1:8080/index.html
```

Bookmark this URL.

You'll see the Bus Tracker interface with an API key panel at the top.

1. Paste your LTA DataMall AccountKey from Phase B.
2. Tap "Save Key".
3. Toast: "API key saved!" — panel closes.

The key is saved in `~/sg-bus-tracker/lta_api_key.txt`. The app never
sends it anywhere except to LTA's own API servers.

### E.3 Verify everything works

1. Search `clementi` → pick any result → arrivals load.
2. Expand any bus card → first/last bus timings appear.
3. Tap "View route" → route list, MRT 🚇 chips with crowding dots.
4. Tap "Show map" → interactive map with the route polyline.
5. Tap "Plan Journey", pick a destination → direct + transfer options.
6. Open a route panel and wait — "You are here" marker appears (needs
   location permission, see Phase H).

---

<a id="phase-f"></a>
## Phase F — Install as a home-screen app (recommended)

1. In Chrome with the app open, tap ⋮ (top right) → "Add to Home screen"
2. Confirm name → "Add"

Now you have a "Bus Tracker" icon that launches full-screen, no URL bar.

---

<a id="phase-g"></a>
## Phase G — Get the full MRT station dataset

The app ships with ~57 major MRT/LRT stations. The full Singapore
network has ~212. For full coverage:

```bash
cd ~/sg-bus-tracker
bash scripts/build-stations.sh
```

This script:

- Queries OneMap's free public Search API for all 212 stations
- Writes results to `data/stations.json`
- Takes 3–5 minutes (500ms polite delay between calls)
- Needs no API key, only `curl` and `jq`

After it finishes:

```bash
bash scripts/stop.sh && bash scripts/start.sh
```

Reload the app. Run again every ~6 months for new station openings.

---

<a id="phase-h"></a>
## Phase H — Grant location permission

Needed for live-location features:

- "You are here" marker on the route list
- Position dot on the route map
- "Nearby stops" feature
- Stops-remaining countdown
- Auto-direction-switch
- Per-stop alighting alarm

Without permission, the rest of the app works normally — location
features simply don't activate.

### First-time prompt

When the app first needs your location, Chrome shows a permission
dialog. Tap **"Allow"**.

If denied by mistake:

1. In Chrome, tap the padlock icon in the URL bar
2. Permissions → Location → Allow
3. Reload

If you installed the PWA (Phase F), permission applies automatically.

### Precision mode

Settings → Apps → Chrome → Permissions → Location → "Use precise
location" must be ON. Approximate mode (~1 km accuracy) is too
imprecise for per-stop tracking and the alarm thresholds.

---

<a id="phase-i"></a>
## Phase I — Notification permission for the alighting alarm

The alighting alarm (v10.11+) sends notifications when you're
approaching your destination. The first time you arm an alarm, Chrome
prompts for notification permission. Tap **"Allow"**.

If you tapped Block by mistake: Chrome → Site settings → 127.0.0.1:8080
→ Notifications → Allow → reload the app.

If you keep notifications denied, the alarm still works — you'll get
vibration, audio chime, and spoken stop name. Just no system tray
notification.

---

<a id="daily-use"></a>
## Daily use

Once setup is done, you never need to open Termux for normal use.

Typical day:

1. Unlock phone → tap "Bus Tracker" icon → arrivals load
2. Done

The proxy is already running (Termux:Boot started it on the last
reboot, and the wake-lock kept it alive).

### Useful Termux commands

```bash
# Is the proxy alive?
bash ~/sg-bus-tracker/scripts/status.sh

# Watch the live log
tail -f ~/.sg-bus-tracker.log

# Stop the proxy
bash ~/sg-bus-tracker/scripts/stop.sh

# Start it manually
bash ~/sg-bus-tracker/scripts/start.sh

# Restart
bash ~/sg-bus-tracker/scripts/stop.sh && bash ~/sg-bus-tracker/scripts/start.sh
```

### Useful URL tricks

- `http://127.0.0.1:8080/index.html?crowdtest=h` — force MRT crowding
  dots to red (test the visual without waiting for peak hour). `l`/`m`/
  `h`/`na` are valid. Tap the pink "CROWD TEST" badge to clear.
- `http://127.0.0.1:8080/logs` — live text feed of app-level logs
- `http://127.0.0.1:8080/ping` — health check endpoint

---

<a id="troubleshooting"></a>
## Troubleshooting

### "Permission denied" running a script

You're probably running it from `/storage/emulated/0/Download/...`,
which doesn't honour the executable bit. Move the project under `~/`
as in Phase C.

### Proxy runs but `status.sh` says "ping — unreachable"

Normal on cold start: Python on Termux takes 1–3 seconds to bind. If
`start.sh` returned successfully, wait 3 seconds and re-run `status.sh`.

If still unreachable after 5+ seconds:

```bash
tail -30 ~/.sg-bus-tracker.log
```

Common cause: `python: command not found` — re-run Phase A.4.

### Auto-start isn't working after reboot

Most common cause: Android battery optimisation killed Termux:Boot
before it ran. Re-check Phase D.1, especially "Unrestricted" battery
for **both** Termux AND Termux:Boot.

Force-test the boot script without rebooting:

```bash
bash ~/.termux/boot/sg-bus-tracker
```

If this works but a real reboot doesn't, it's an OEM restriction issue.

### Train alerts banner never appears

Normal — alerts only show during actual disruptions. To test the
endpoint manually:

```bash
curl "http://127.0.0.1:8080/lta/TrainServiceAlerts" | jq .
```

### MRT crowding dots don't appear

Check you're on a stop whose route passes near an MRT station in the
bundled dataset. If using the seed dataset (Phase G not run), only
~57 major interchanges will light up.

Test the rendering without waiting for peak hour:

```
http://127.0.0.1:8080/index.html?crowdtest=h
```

If red dots appear with the override but not naturally, the LTA API
isn't returning data for those lines. Check the log for `[crowding]`
lines.

### "You are here" marker never appears

Five things to check, in order:

1. Phase H done? Chrome must have location permission.
2. GPS turned on in Android system settings.
3. Precise location enabled (approximate mode is too imprecise).
4. Within 250m of a stop on this route. If not, "Not on this route"
   shows instead — that's correct behaviour.
5. Indoors? GPS accuracy often >200m indoors → "GPS signal weak"
   notice. Step outside to verify.

The feature is silent by design when unavailable.

### Marker stuck on a passed stop after boarding mid-route

v10.7 fixed this — the algorithm uses two consecutive GPS fixes to
infer direction of travel and pick the upcoming stop, not the
geographically closest one. There's a brief 3–6 second period right
after panel open where it may show the previous stop; it self-corrects.

If it stays stuck longer than that, check `tail ~/.sg-bus-tracker.log
| grep liveloc` — diagnostic logs explain the algorithm's decisions.

### Map shows the route as straight lines between stops

Known limitation. LTA's API doesn't provide the road geometry between
stops, so the polyline connects stops point-to-point. The line is for
visual orientation only — actual bus path follows roads, of course.

Adding road-following polylines would require either OneMap routing
API integration (with token management) or a precomputed geometry
dataset. Both are substantial projects for purely cosmetic gain.

### Search misses some stops

v10.8 + v10.9 fixed silent truncation. Search now scans all ~5500
stops and shows up to 100 results. If results are capped, the footer
"Showing 100 of N matches" tells you to refine.

### Nearby stops misses some

v10.10 fixed the cap. All stops within 600m now appear, sorted by
distance.

### Alighting alarm doesn't fire

Check in this order:

1. App is in foreground? PWAs can't run reliably with the app fully
   closed. Wake-lock keeps the screen on while armed.
2. Notification permission granted? (Phase I)
3. Volume up? The chime needs audio output.
4. Vibration enabled in Android settings for browser?
5. Phone unlocked? Geolocation stops on most Android browsers when
   the device is locked.

For "phone in pocket" reliability, this PWA isn't the right tool —
SG BusLeh has it as a native Android app.

### Speech mispronounces stop names

The TTS engine reads abbreviations literally unless we expand them.
The alarm expands ~25 common ones (Blk → Block, Stn → Station, etc.)
but Singapore place names (Bedok, Bishan, Tanah Merah) rely on the
default English voice and may sound off. The user knows what stop
they meant.

If a specific stop is consistently mangled in a way that's confusing,
file an issue and I can add an explicit pronunciation override.

---

<a id="updating"></a>
## Updating to a newer version

If installed via git clone:

```bash
bash ~/sg-bus-tracker/scripts/stop.sh
cd ~/sg-bus-tracker
git pull
chmod +x scripts/*.sh
bash scripts/start.sh
```

Reload the app in Chrome — the service worker auto-evicts the old
cache.

If installed from a zip:

```bash
bash ~/sg-bus-tracker/scripts/stop.sh

# Save your API key
cp ~/sg-bus-tracker/lta_api_key.txt ~/lta_api_key_backup.txt

# Replace the directory
cd ~
rm -rf sg-bus-tracker
unzip ~/storage/downloads/sg-bus-tracker-NEW.zip
cd sg-bus-tracker
chmod +x scripts/*.sh

# Restore the key
cp ~/lta_api_key_backup.txt lta_api_key.txt

bash scripts/start.sh
```

The boot symlink in `~/.termux/boot/sg-bus-tracker` keeps working as
long as the project directory name doesn't change.

---

<a id="uninstalling"></a>
## Uninstalling

```bash
# Stop the proxy
bash ~/sg-bus-tracker/scripts/stop.sh

# Remove the boot hook
rm ~/.termux/boot/sg-bus-tracker

# Remove the app
rm -rf ~/sg-bus-tracker

# Remove logs
rm -f ~/.sg-bus-tracker.log ~/.sg-bus-tracker.pid
```

To also remove tools:

```bash
pkg remove python curl jq git
```

To remove Termux itself: long-press the icon → Uninstall. Same for
Termux:Boot and F-Droid if not used elsewhere.

App data stored in Chrome (favourites, last location): Chrome →
Settings → Site settings → 127.0.0.1:8080 → Clear & reset.
