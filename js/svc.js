// ── Service badge colour ─────────────────────────────
// Colours map to operator brand when known (from /BusServices), or fall back
// to a number-range heuristic until that data is loaded. A single definition
// used by arrivals, route, and planner.
//
// Operator reference (as returned by LTA's /BusServices endpoint):
//   SBST — SBS Transit       (red)
//   SMRT — SMRT Buses        (orange)
//   TTS  — Tower Transit SG  (teal)
//   GAS  — Go-Ahead SG       (blue)
//
// The operator cache (busServicesCache) is populated by route.js. Until a
// service's operator is known, we use the existing number-range fallback so
// badges still get a reasonable colour on first render.

import { state } from './state.js';

const OPERATOR_CLASS = {
  SBST: 'svc-sbst',
  SMRT: 'svc-smrt',
  TTS:  'svc-tts',
  GAS:  'svc-gas',
};

function byNumber(no) {
  const n = parseInt(no) || 0;
  if (/[MAEN]$/.test(no)) return 'svc-teal';
  if (n <= 39)  return 'svc-red';
  if (n <= 79)  return 'svc-orange';
  if (n <= 119) return 'svc-blue';
  if (n <= 159) return 'svc-green';
  if (n <= 199) return 'svc-purple';
  if (n <= 299) return 'svc-navy';
  return 'svc-maroon';
}

export function svcColor(no) {
  const info = state.busServicesCache[no];
  if (info) {
    // Cache is keyed by direction → { operator, origin, dest, cat }
    // Any direction's operator will do; grab the first.
    for (const dir of Object.keys(info)) {
      const op = info[dir] && info[dir].operator;
      if (op && OPERATOR_CLASS[op]) return OPERATOR_CLASS[op];
    }
  }
  return byNumber(no);
}

// Resolve a human-readable operator name (for tooltips/legend)
export function operatorName(no) {
  const info = state.busServicesCache[no];
  if (!info) return null;
  for (const dir of Object.keys(info)) {
    const op = info[dir] && info[dir].operator;
    if (op === 'SBST') return 'SBS Transit';
    if (op === 'SMRT') return 'SMRT Buses';
    if (op === 'TTS')  return 'Tower Transit';
    if (op === 'GAS')  return 'Go-Ahead SG';
  }
  return null;
}
