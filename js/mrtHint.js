// ── T7: MRT hint for the journey planner ─────────────
// A lightweight "consider taking the train" suggestion when the journey
// planner's origin and destination are both near MRT stations.
//
// Scope (deliberately limited — see README):
//   - Same-line trips: count stops via code numbering
//   - 1-transfer trips: find any shared interchange station
//   - 2+ transfers: skipped
//
// This is NOT a full multi-modal router. For accurate routing use Google
// Maps. The point is to flag "hey, MRT might be better here" so the user
// isn't caught blindly taking a 40-minute bus when an 18-minute train
// exists.

import { stationsNear } from './stations.js';

// ── Tunables ──────────────────────────────────────────
const WALK_SPEED_MPM = 80;            // metres per minute (~4.8 km/h comfortable walking)
const MAX_WALK_DIST_M = 400;          // don't suggest MRT if either leg is further than this
const TRAIN_MIN_PER_HOP = 1.5;        // avg ride between adjacent stations (MRT lines)
const LRT_MIN_PER_HOP = 1.8;          // LRT is slower
const PLATFORM_WAIT_MIN = 3;          // typical daytime wait; we don't have real schedules
const TRANSFER_PENALTY_MIN = 5;       // walking between platforms + waiting

// Which codes belong to which line. Matches stations.json.
const LINE_PREFIX = {
  NS: 'NSL', EW: 'EWL', NE: 'NEL', CC: 'CCL', CE: 'CCL', CG: 'EWL',
  DT: 'DTL', TE: 'TEL',
  BP: 'BPL',
  // Sengkang LRT (codes: SW/SE, terminus STC)
  SW: 'SKL', SE: 'SKL', ST: 'SKL',
  // Punggol LRT (codes: PW/PE, terminus PTC)
  PW: 'PGL', PE: 'PGL', PT: 'PGL',
};

function isLrt(line) {
  return line === 'BPL' || line === 'SKL' || line === 'PGL';
}

// Parse a code like "NS24" into { prefix: "NS", number: 24 }.
// Special handling for single-code stations like "STC", "PTC" (LRT termini).
function parseCode(code) {
  const m = code.match(/^([A-Z]+)(\d*)$/);
  if (!m) return null;
  return { prefix: m[1], number: m[2] ? parseInt(m[2], 10) : null };
}

function codeLine(code) {
  const parsed = parseCode(code);
  if (!parsed) return null;
  // Try 3-letter prefix first (STC, PTC), then 2-letter (NS, EW, etc.)
  return LINE_PREFIX[parsed.prefix] || LINE_PREFIX[parsed.prefix.substring(0, 2)] || null;
}

// Stations on each line — populated lazily from the full stations dataset.
// Map<line, Map<code, { number, name }>>
let lineIndex = null;
// Map<stationName, Array<{ code, line }>> — for interchange detection
let nameToCodes = null;

function buildIndex(stations) {
  if (lineIndex) return;
  lineIndex = new Map();
  nameToCodes = new Map();
  for (const s of stations) {
    const line = codeLine(s.code);
    if (!line) continue;
    if (!lineIndex.has(line)) lineIndex.set(line, new Map());
    const parsed = parseCode(s.code);
    lineIndex.get(line).set(s.code, { number: parsed ? parsed.number : null, name: s.name });
    if (!nameToCodes.has(s.name)) nameToCodes.set(s.name, []);
    nameToCodes.get(s.name).push({ code: s.code, line });
  }
}

// Returns the number of stops between two codes on the SAME line, or null
// if they aren't on the same line. Uses the numeric part of the code.
// Works for all mainline MRT (NS/EW/NE/CC/DT/TE). LRT is approximate.
function sameLineHops(codeA, codeB) {
  const a = parseCode(codeA);
  const b = parseCode(codeB);
  if (!a || !b) return null;
  if (codeLine(codeA) !== codeLine(codeB)) return null;
  if (a.number == null || b.number == null) return null;
  return Math.abs(a.number - b.number);
}

// Given two codes, find the best train path.
// Returns { legs: [{ fromCode, toCode, line, hops }], totalMin, transfers } or null.
function findTrainPath(fromCode, toCode) {
  if (!lineIndex) return null;
  if (fromCode === toCode) return { legs: [], totalMin: 0, transfers: 0 };

  // Same line direct
  const direct = sameLineHops(fromCode, toCode);
  if (direct !== null) {
    const line = codeLine(fromCode);
    const mpm = isLrt(line) ? LRT_MIN_PER_HOP : TRAIN_MIN_PER_HOP;
    return {
      legs: [{ fromCode, toCode, line, hops: direct, fromName: lineIndex.get(line).get(fromCode)?.name, toName: lineIndex.get(line).get(toCode)?.name }],
      totalMin: PLATFORM_WAIT_MIN + direct * mpm,
      transfers: 0,
    };
  }

  // 1-transfer: for each station X on fromLine, if X is an interchange with toLine, try routing via X.
  const fromLine = codeLine(fromCode);
  const toLine = codeLine(toCode);
  if (!fromLine || !toLine) return null;

  let best = null;
  const fromLineStops = lineIndex.get(fromLine);
  const toLineStops = lineIndex.get(toLine);
  if (!fromLineStops || !toLineStops) return null;

  for (const [codeOnFromLine, info] of fromLineStops) {
    // Is the same-named station also on toLine?
    const siblings = nameToCodes.get(info.name) || [];
    const siblingOnToLine = siblings.find(s => s.line === toLine);
    if (!siblingOnToLine) continue;

    const leg1Hops = sameLineHops(fromCode, codeOnFromLine);
    const leg2Hops = sameLineHops(siblingOnToLine.code, toCode);
    if (leg1Hops == null || leg2Hops == null) continue;
    if (leg1Hops === 0 && leg2Hops === 0) continue; // degenerate

    const mpm1 = isLrt(fromLine) ? LRT_MIN_PER_HOP : TRAIN_MIN_PER_HOP;
    const mpm2 = isLrt(toLine)   ? LRT_MIN_PER_HOP : TRAIN_MIN_PER_HOP;
    const totalMin =
      PLATFORM_WAIT_MIN +
      leg1Hops * mpm1 +
      TRANSFER_PENALTY_MIN +
      leg2Hops * mpm2;

    if (!best || totalMin < best.totalMin) {
      best = {
        legs: [
          { fromCode, toCode: codeOnFromLine, line: fromLine, hops: leg1Hops,
            fromName: fromLineStops.get(fromCode)?.name,
            toName: info.name },
          { fromCode: siblingOnToLine.code, toCode, line: toLine, hops: leg2Hops,
            fromName: info.name,
            toName: toLineStops.get(toCode)?.name },
        ],
        totalMin,
        transfers: 1,
        transferStationName: info.name,
      };
    }
  }
  return best;
}

function walkMinutes(metres) {
  return Math.max(1, Math.ceil(metres / WALK_SPEED_MPM));
}

// The public API. Takes origin + destination stop objects (with Latitude/Longitude)
// and returns an MRT hint or null.
// Signature:
//   { originWalk: { min, dist, station: {name, codes, lines} },
//     trainPath: { legs, totalMin, transfers },
//     destWalk:   { min, dist, station },
//     totalMin }
// Or null if no viable MRT option.
export function mrtHintForJourney(origin, dest, stationsData) {
  if (!origin || !dest || !stationsData || !stationsData.length) return null;
  buildIndex(stationsData);

  const originStations = stationsNear(origin.Latitude, origin.Longitude)
    .filter(s => s.distanceM <= MAX_WALK_DIST_M);
  const destStations = stationsNear(dest.Latitude, dest.Longitude)
    .filter(s => s.distanceM <= MAX_WALK_DIST_M);

  if (!originStations.length || !destStations.length) return null;

  // Try every (origin station, dest station, fromCode, toCode) combination
  // and keep the one with the lowest total time.
  let best = null;

  for (const oSt of originStations) {
    for (const dSt of destStations) {
      if (oSt.name === dSt.name) {
        // Same station at both ends — MRT isn't the answer, walking is.
        // Skip, let the planner show bus options.
        continue;
      }
      // Try each (fromCode, toCode) pair: some interchanges offer multiple
      // physical codes on different lines, e.g. Dhoby Ghaut NS24/NE6/CC1.
      for (const fromCode of oSt.codes) {
        for (const toCode of dSt.codes) {
          const path = findTrainPath(fromCode, toCode);
          if (!path) continue;

          const walkMinO = walkMinutes(oSt.distanceM);
          const walkMinD = walkMinutes(dSt.distanceM);
          const totalMin = walkMinO + path.totalMin + walkMinD;

          if (!best || totalMin < best.totalMin) {
            best = {
              originWalk: { min: walkMinO, dist: oSt.distanceM, station: oSt },
              trainPath: path,
              destWalk: { min: walkMinD, dist: dSt.distanceM, station: dSt },
              totalMin,
            };
          }
        }
      }
    }
  }

  return best;
}
