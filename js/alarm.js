// ── T18: Alighting alarm ──────────────────────────────
// Lets the user "set an alarm" for a specific stop on a route. When
// they're approaching it, the app fires:
//   - System notification (if permitted)
//   - Vibration burst
//   - Audio chime
//   - Spoken stop name via SpeechSynthesis
//
// Two thresholds:
//   - 250m  → "Approaching" alert (~30s warning)
//   - 80m   → "Arriving" alert (final notice)
//
// Honest scope: this works ONLY while the app is in the foreground.
// PWAs can't reliably run code when the phone is locked or the app
// is fully closed. The UI explicitly tells the user "screen must
// stay on" so expectations are correct.
//
// To keep the screen alive during the journey we acquire a
// `Screen Wake Lock` when the alarm is armed.

import { state } from './state.js';
import { $id, esc } from './dom.js';
import { showToast } from './toast.js';
import { addPositionListener, removePositionListener } from './liveLocation.js';
import { log } from './log.js';

// ── Tunables ──────────────────────────────────────────
const APPROACHING_M = 250;
const ARRIVING_M    = 80;
const VISIT_M       = 80;     // T19: stop is "visited" when within this distance
const VIBRATE_APPROACHING = [200, 100, 200];
const VIBRATE_ARRIVING    = [400, 100, 400, 100, 400];

// ── State (per panel session) ─────────────────────────
let armedTarget = null;       // { stopCode, stopName, lat, lng } or null
let firedApproaching = false; // monotonic — once fired, never again this session
let firedArriving = false;
let positionListener = null;
let wakeLock = null;
let voicesReady = false;
// T19: route stops + visited tracking for per-stop announcements
let routeStops = [];          // [{code, name, seq, lat, lng}] from arm to destination, sorted
let destSeq = null;           // sequence number of destination within routeStops
let visitedSeqs = new Set();  // sequences already announced to avoid repeats
let firstFixSeenStop = null;  // seq of the stop user was nearest at arm-time
                              // (we don't announce stops we already passed before arming)
let audioCtx = null;          // T19: persistent audio context (kept alive while armed)

// ── Speech: abbreviation expansion ────────────────────
// Bus stop names are full of abbreviations that TTS reads literally.
// "Blk 55 Bedok Stn Exit B" would read as "B L K 55 Bedok S T N Exit B".
// Expand the common ones so it sounds natural.
const ABBR_MAP = [
  // Word-boundary replacements (case-insensitive)
  [/\bBlk\b/gi,  'Block'],
  [/\bStn\b/gi,  'Station'],
  [/\bOpp\b/gi,  'Opposite'],
  [/\bAft\b/gi,  'After'],
  [/\bBef\b/gi,  'Before'],
  [/\bBef'r\b/gi,'Before'],
  [/\bInd\b/gi,  'Industrial'],
  [/\bCplx\b/gi, 'Complex'],
  [/\bPk\b/gi,   'Park'],
  [/\bRd\b/gi,   'Road'],
  [/\bAve\b/gi,  'Avenue'],
  [/\bSt\b/gi,   'Street'],
  [/\bCres\b/gi, 'Crescent'],
  [/\bCir\b/gi,  'Circle'],
  [/\bDr\b/gi,   'Drive'],
  [/\bLk\b/gi,   'Lake'],
  [/\bNth\b/gi,  'North'],
  [/\bSth\b/gi,  'South'],
  [/\bCtrl\b/gi, 'Central'],
  [/\bSec\b/gi,  'Secondary'],
  [/\bPri\b/gi,  'Primary'],
  [/\bSch\b/gi,  'School'],
  [/\bTer\b/gi,  'Terminal'],
  [/\bInt\b/gi,  'Interchange'],
  [/\bGdn\b/gi,  'Garden'],
  [/\bGdns\b/gi, 'Gardens'],
  [/\bCres\b/gi, 'Crescent'],
  [/\bChc\b/gi,  'Church'],
  [/\bMkt\b/gi,  'Market'],
  [/\bTpkg\b/gi, 'Tampines'],
  [/\bCC\b/g,    'Community Club'],
  [/\bCBP\b/g,   'Changi Business Park'],
];

function expandAbbreviations(text) {
  let out = text;
  for (const [re, replacement] of ABBR_MAP) {
    out = out.replace(re, replacement);
  }
  return out;
}

// ── Speech ────────────────────────────────────────────
function ensureVoicesLoaded() {
  if (voicesReady) return;
  // getVoices() may return [] until voices load. Trigger and wait.
  const v = window.speechSynthesis?.getVoices();
  if (v && v.length > 0) { voicesReady = true; return; }
  if (window.speechSynthesis) {
    window.speechSynthesis.addEventListener('voiceschanged', () => { voicesReady = true; }, { once: true });
  }
}

// T19: priority='high' barges in (cancels in-flight speech) — used for
// destination alerts where the user MUST hear them. priority='low'
// queues — used for per-stop announcements where overlap protection
// matters more than immediacy.
function speak(text, priority = 'high') {
  if (!('speechSynthesis' in window)) return;
  try {
    if (priority === 'high') {
      window.speechSynthesis.cancel();
    }
    const u = new SpeechSynthesisUtterance(expandAbbreviations(text));
    u.rate = 1.0;
    u.pitch = 1.0;
    u.volume = 1.0;
    // Prefer en-SG / en-GB / en-AU / en-US voices in that order
    const voices = window.speechSynthesis.getVoices();
    const prefer = ['en-SG', 'en-GB', 'en-AU', 'en-US', 'en'];
    for (const lang of prefer) {
      const v = voices.find(vo => vo.lang === lang || vo.lang.startsWith(lang + '-'));
      if (v) { u.voice = v; u.lang = v.lang; break; }
    }
    if (!u.lang) u.lang = 'en-US';
    window.speechSynthesis.speak(u);
  } catch (err) {
    log.warn('alarm', 'speech failed', err);
  }
}

// T19: Persistent audio context. Previously we created and closed a
// fresh AudioContext per chime. In hidden tabs, opening a new context
// is more likely to fail than reusing one created during a user gesture.
// We open it on arm (the user gesture) and keep it alive until disarm.
function ensureAudioCtx() {
  if (audioCtx) {
    // Some browsers auto-suspend on tab hide; resume best-effort
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = new Ctx();
    return audioCtx;
  } catch (_) {
    return null;
  }
}

function closeAudioCtx() {
  if (audioCtx) {
    try { audioCtx.close(); } catch (_) {}
    audioCtx = null;
  }
}

function playChime(double = false) {
  try {
    const ctx = ensureAudioCtx();
    if (!ctx) return;
    const beep = (when, freq, duration) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.type = 'sine';
      osc.connect(gain);
      gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0, ctx.currentTime + when);
      gain.gain.linearRampToValueAtTime(0.3, ctx.currentTime + when + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + when + duration);
      osc.start(ctx.currentTime + when);
      osc.stop(ctx.currentTime + when + duration);
    };
    beep(0,    880, 0.18);             // A5
    if (double) beep(0.22, 1175, 0.25); // D6 — higher second beep for arriving
    // Don't close the context here — keep it alive for the next chime
  } catch (err) {
    log.warn('alarm', 'chime failed', err);
  }
}

function vibrate(pattern) {
  try {
    if (navigator.vibrate) navigator.vibrate(pattern);
  } catch (_) { /* ignore */ }
}

// Sends a system notification. Async because permission may need to be
// requested. Falls back silently if denied.
async function notify(title, body) {
  if (!('Notification' in window)) return;
  try {
    if (Notification.permission === 'default') {
      await Notification.requestPermission();
    }
    if (Notification.permission !== 'granted') return;
    new Notification(title, { body, tag: 'alighting-alarm' });
  } catch (err) {
    log.warn('alarm', 'notification failed', err);
  }
}

// ── Wake lock ─────────────────────────────────────────
async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) {
    log.info('alarm', 'wakeLock API not supported');
    return;
  }
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    log.info('alarm', 'wake lock acquired');
    wakeLock.addEventListener('release', () => {
      log.info('alarm', 'wake lock released by system');
    });
  } catch (err) {
    log.warn('alarm', 'wake lock request failed', err);
  }
}

async function releaseWakeLock() {
  if (wakeLock) {
    try { await wakeLock.release(); } catch (_) {}
    wakeLock = null;
  }
}

// Re-acquire on visibility — Android may release the lock when tab loses focus
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && armedTarget && !wakeLock) {
    acquireWakeLock();
  }
});

// ── Distance ──────────────────────────────────────────
function haversineM(lat1, lng1, lat2, lng2) {
  const toRad = (d) => d * Math.PI / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ── Public API ────────────────────────────────────────
export function isArmed(stopCode) {
  return armedTarget && armedTarget.stopCode === stopCode;
}

export function isAnyArmed() {
  return armedTarget !== null;
}

// T19: armAlarm now takes the full ordered list of route stops (current
// direction) so it can announce per-stop progress. Caller supplies them
// from boarding stop onward; alarm picks the index of `stop` within
// that list as the destination.
//
// stop = { BusStopCode, Description, Latitude, Longitude }
// allStops = [{ BusStopCode, StopSequence, Description, Latitude, Longitude }, ...]
//   (must include `stop` somewhere in this list)
export async function armAlarm(stop, allStops = []) {
  if (!stop || typeof stop.Latitude !== 'number') {
    showToast('Cannot set alarm: stop has no coordinates', 'error');
    return false;
  }

  // Reset any prior alarm
  await disarmAlarm();

  armedTarget = {
    stopCode: stop.BusStopCode,
    stopName: stop.Description || stop.BusStopCode,
    lat: stop.Latitude,
    lng: stop.Longitude,
  };
  firedApproaching = false;
  firedArriving = false;
  visitedSeqs = new Set();
  firstFixSeenStop = null;

  // T19: build the route-stop list for per-stop announcements. We only
  // need stops up to and including the destination; stops beyond are
  // irrelevant. Filter out any without coordinates.
  routeStops = [];
  destSeq = null;
  if (Array.isArray(allStops) && allStops.length) {
    const destIdx = allStops.findIndex(s => s.BusStopCode === stop.BusStopCode);
    if (destIdx !== -1) {
      routeStops = allStops
        .slice(0, destIdx + 1)
        .filter(s => typeof s.Latitude === 'number' && typeof s.Longitude === 'number')
        .map(s => ({
          code: s.BusStopCode,
          name: s.Description || s.BusStopCode,
          seq: s.StopSequence,
          lat: s.Latitude,
          lng: s.Longitude,
        }));
      destSeq = stop.StopSequence ?? routeStops[routeStops.length - 1]?.seq ?? null;
    }
  }
  // Fallback for arms with no stop list provided (legacy callers): empty
  // routeStops means per-stop announcements simply won't fire, but the
  // 250m / 80m destination alerts still work.

  // Trigger TTS warmup with a silent utterance so subsequent speak()
  // calls work. This counts as the user gesture.
  ensureVoicesLoaded();
  try {
    if ('speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0; u.rate = 10;
      window.speechSynthesis.speak(u);
    }
  } catch (_) {}

  // T19: prime the audio context inside the user gesture (the click that
  // armed the alarm). Browsers are more permissive about reusing a
  // gesture-created context in hidden tabs than creating a fresh one.
  ensureAudioCtx();

  // Pre-request notification permission so the first alert isn't blocked
  // by a permission prompt at the worst moment
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }

  // Subscribe to position updates
  positionListener = (pos) => onPosition(pos);
  addPositionListener(positionListener);

  // Keep screen on
  await acquireWakeLock();

  // Also set state.planDestStop so the existing "stops to go" banner
  // activates. This piggybacks on existing v10.6 logic without
  // reinventing it.
  state.planDestStop = {
    BusStopCode: stop.BusStopCode,
    Description: stop.Description,
    RoadName: stop.RoadName,
    Latitude: stop.Latitude,
    Longitude: stop.Longitude,
  };

  log.info('alarm', `armed for ${armedTarget.stopName} (${armedTarget.stopCode}), routeStops=${routeStops.length}`);
  showToast(`Alarm set for ${armedTarget.stopName}. Keep app open & screen on.`, 'success', null, 4000);
  return true;
}

export async function disarmAlarm() {
  if (positionListener) {
    removePositionListener(positionListener);
    positionListener = null;
  }
  await releaseWakeLock();
  if (armedTarget) {
    log.info('alarm', `disarmed (was ${armedTarget.stopName})`);
  }
  armedTarget = null;
  firedApproaching = false;
  firedArriving = false;
  // T19: clean up new state
  routeStops = [];
  destSeq = null;
  visitedSeqs = new Set();
  firstFixSeenStop = null;
  closeAudioCtx();
  // Stop any in-flight speech
  try { window.speechSynthesis?.cancel(); } catch (_) {}
  // Note: deliberately don't clear state.planDestStop — user may have set
  // it through the planner; we shouldn't unset their destination just
  // because they disarmed an alarm.
}

function onPosition(pos) {
  if (!armedTarget) return;
  const dist = haversineM(pos.lat, pos.lng, armedTarget.lat, armedTarget.lng);
  log.info('alarm', `dist to ${armedTarget.stopName}: ${Math.round(dist)}m`);

  // T19: per-stop tracking. For every stop in the route up to (but not
  // including) the destination, check if user is within VISIT_M and
  // hasn't been announced yet. If so, fire "Just passed X, N stops to go"
  // (voice only, no chime/vibration).
  //
  // On the very first position fix, we don't announce — we just record
  // which stop the user was nearest. That's the "boarding stop" which
  // we never announce as "just passed" (the user already knows where
  // they boarded). Subsequent fixes announce stops as they're visited.
  if (routeStops.length) {
    if (firstFixSeenStop === null) {
      // First fix after arming. Find nearest stop and silently mark it
      // and all earlier stops as already-passed so we don't announce
      // them retroactively.
      let nearest = null;
      let nearestDist = Infinity;
      for (const s of routeStops) {
        const d = haversineM(pos.lat, pos.lng, s.lat, s.lng);
        if (d < nearestDist) { nearestDist = d; nearest = s; }
      }
      if (nearest) {
        firstFixSeenStop = nearest.seq;
        // Silently mark all stops up to and including the boarding stop
        // as visited — we never announce them.
        for (const s of routeStops) {
          if (s.seq <= nearest.seq) visitedSeqs.add(s.seq);
        }
        log.info('alarm', `boarding stop seq=${nearest.seq} (${nearest.name}), suppressing earlier announcements`);
      }
    } else {
      // Normal fix. Check each not-yet-visited stop (excluding the
      // destination — which has its own arriving alert) for visit.
      for (const s of routeStops) {
        if (visitedSeqs.has(s.seq)) continue;
        if (s.seq === destSeq) continue; // destination → arriving alert handles it
        const d = haversineM(pos.lat, pos.lng, s.lat, s.lng);
        if (d <= VISIT_M) {
          visitedSeqs.add(s.seq);
          announceJustPassed(s);
        }
      }
    }
  }

  // T19: destination alerts with skipped-threshold robustness.
  //
  // If between two fixes the bus crosses BOTH the 250m and 80m thresholds
  // (e.g. 400m last fix → 60m this fix, common in hidden tabs where
  // updates arrive every 30-60s), fire approaching first then arriving
  // so the user gets both in correct order rather than just the latest.
  if (!firedApproaching && dist <= APPROACHING_M) {
    firedApproaching = true;
    fireApproaching();
    // If we've also crossed into arriving range in the same fix, fire
    // arriving as well after a short delay so both alerts are heard.
    if (!firedArriving && dist <= ARRIVING_M) {
      firedArriving = true;
      // Delay so the approaching speech doesn't get cancelled by arriving
      setTimeout(() => fireArriving(), 1500);
    }
  } else if (!firedArriving && dist <= ARRIVING_M) {
    firedArriving = true;
    fireArriving();
  }
}

// T19: per-stop announcement. Voice only — no chime, no vibration.
// "Just passed Bedok Sports Cplx. 8 stops to go" / "1 stop to go".
function announceJustPassed(stop) {
  if (destSeq === null) return;
  // Compute stops remaining: number of stops between this stop's seq
  // and destination's seq, exclusive of this stop.
  // Simple model: stops to go = destination index - this stop's index.
  const idxThis = routeStops.findIndex(s => s.seq === stop.seq);
  const idxDest = routeStops.findIndex(s => s.seq === destSeq);
  if (idxThis === -1 || idxDest === -1) return;
  const stopsLeft = idxDest - idxThis;
  if (stopsLeft <= 0) return; // shouldn't happen, but be defensive
  const stopsLeftWord = stopsLeft === 1 ? '1 stop' : `${stopsLeft} stops`;
  const text = `Just passed ${stop.name}. ${stopsLeftWord} to go.`;
  log.info('alarm', `announce: ${text}`);
  speak(text, 'low'); // queue, don't barge in
}

function fireApproaching() {
  const name = armedTarget.stopName;
  log.info('alarm', `APPROACHING ${name}`);
  vibrate(VIBRATE_APPROACHING);
  playChime(false);
  // T19: queue the speech so any in-flight "Just passed N stops to go"
  // announcement isn't cut off. Vibration + chime have already grabbed
  // attention; speech can play a moment later.
  speak(`Approaching ${name}`, 'low');
  notify('🔔 Approaching stop', `${name} — about 30 seconds away`);
}

function fireArriving() {
  const name = armedTarget.stopName;
  log.info('alarm', `ARRIVING at ${name}`);
  vibrate(VIBRATE_ARRIVING);
  playChime(true);
  // T19: at this point per-stop progress announcements are no longer
  // useful — the user is arriving NOW. Cancel any queued speech (which
  // may include the "Approaching" alert if both fired in the same fix)
  // so the final "Arriving" message is heard cleanly and isn't lost
  // behind a long queue.
  try { window.speechSynthesis?.cancel(); } catch (_) {}
  speak(`Arriving at ${name}. Press the bell now.`, 'high');
  notify('🔔 Arriving now', name);
  // Auto-disarm after the final alert — alarm has done its job.
  // Bumped from 5s to 8s so the speech has time to finish before
  // disarmAlarm cancels everything.
  setTimeout(() => {
    if (armedTarget) disarmAlarm();
  }, 8000);
}
