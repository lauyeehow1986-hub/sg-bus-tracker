#!/usr/bin/env bash
# T5.2 helper: build a complete data/stations.json by geocoding the MRT/LRT
# station list via OneMap's free public Search API.
#
# Why this version:
#   The original approach needed pyproj/pyshp to convert LTA's SVY21 shapefile
#   to WGS84, but pyproj requires the native PROJ C library which isn't
#   available in Termux by default. OneMap's Search API returns WGS84 lat/lng
#   directly, so we skip the whole shapefile + projection pipeline.
#
# Requirements:
#   - curl  (Termux: pkg install curl)
#   - jq    (Termux: pkg install jq)
#   - Internet access to www.onemap.gov.sg (no API key needed for Search)
#
# Usage:
#   cd sg-bus-v8
#   chmod +x scripts/build-stations.sh      # first time only
#   ./scripts/build-stations.sh
#
# Output:
#   Rewrites data/stations.json with ~170 stations.
#
# Runtime:
#   ~3-5 minutes on a reasonable connection. 500ms sleep between calls
#   to be polite to OneMap's free service.

set -euo pipefail
cd "$(dirname "$0")/.."

# Dep checks
for cmd in curl jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "✗ Missing required tool: $cmd"
    echo "  On Termux:          pkg install $cmd"
    echo "  On Debian/Ubuntu:   apt install $cmd"
    exit 1
  fi
done

# The authoritative MRT + LRT station list (as of TEL 4 opening, Jun 2024).
# Format: "CODE|Display Name|LINE|SearchQueryForOneMap"
STATIONS=(
  # North-South Line
  "NS1|Jurong East|NSL|jurong east mrt"
  "NS2|Bukit Batok|NSL|bukit batok mrt"
  "NS3|Bukit Gombak|NSL|bukit gombak mrt"
  "NS4|Choa Chu Kang|NSL|choa chu kang mrt"
  "NS5|Yew Tee|NSL|yew tee mrt"
  "NS7|Kranji|NSL|kranji mrt"
  "NS8|Marsiling|NSL|marsiling mrt"
  "NS9|Woodlands|NSL|woodlands mrt"
  "NS10|Admiralty|NSL|admiralty mrt"
  "NS11|Sembawang|NSL|sembawang mrt"
  "NS12|Canberra|NSL|canberra mrt"
  "NS13|Yishun|NSL|yishun mrt"
  "NS14|Khatib|NSL|khatib mrt"
  "NS15|Yio Chu Kang|NSL|yio chu kang mrt"
  "NS16|Ang Mo Kio|NSL|ang mo kio mrt"
  "NS17|Bishan|NSL|bishan mrt"
  "NS18|Braddell|NSL|braddell mrt"
  "NS19|Toa Payoh|NSL|toa payoh mrt"
  "NS20|Novena|NSL|novena mrt"
  "NS21|Newton|NSL|newton mrt"
  "NS22|Orchard|NSL|orchard mrt"
  "NS23|Somerset|NSL|somerset mrt"
  "NS24|Dhoby Ghaut|NSL|dhoby ghaut mrt"
  "NS25|City Hall|NSL|city hall mrt"
  "NS26|Raffles Place|NSL|raffles place mrt"
  "NS27|Marina Bay|NSL|marina bay mrt"
  "NS28|Marina South Pier|NSL|marina south pier mrt"

  # East-West Line
  "EW1|Pasir Ris|EWL|pasir ris mrt"
  "EW2|Tampines|EWL|tampines mrt"
  "EW3|Simei|EWL|simei mrt"
  "EW4|Tanah Merah|EWL|tanah merah mrt"
  "EW5|Bedok|EWL|bedok mrt"
  "EW6|Kembangan|EWL|kembangan mrt"
  "EW7|Eunos|EWL|eunos mrt"
  "EW8|Paya Lebar|EWL|paya lebar mrt"
  "EW9|Aljunied|EWL|aljunied mrt"
  "EW10|Kallang|EWL|kallang mrt"
  "EW11|Lavender|EWL|lavender mrt"
  "EW12|Bugis|EWL|bugis mrt"
  "EW13|City Hall|EWL|city hall mrt"
  "EW14|Raffles Place|EWL|raffles place mrt"
  "EW15|Tanjong Pagar|EWL|tanjong pagar mrt"
  "EW16|Outram Park|EWL|outram park mrt"
  "EW17|Tiong Bahru|EWL|tiong bahru mrt"
  "EW18|Redhill|EWL|redhill mrt"
  "EW19|Queenstown|EWL|queenstown mrt"
  "EW20|Commonwealth|EWL|commonwealth mrt"
  "EW21|Buona Vista|EWL|buona vista mrt"
  "EW22|Dover|EWL|dover mrt"
  "EW23|Clementi|EWL|clementi mrt"
  "EW24|Jurong East|EWL|jurong east mrt"
  "EW25|Chinese Garden|EWL|chinese garden mrt"
  "EW26|Lakeside|EWL|lakeside mrt"
  "EW27|Boon Lay|EWL|boon lay mrt"
  "EW28|Pioneer|EWL|pioneer mrt"
  "EW29|Joo Koon|EWL|joo koon mrt"
  "EW30|Gul Circle|EWL|gul circle mrt"
  "EW31|Tuas Crescent|EWL|tuas crescent mrt"
  "EW32|Tuas West Road|EWL|tuas west road mrt"
  "EW33|Tuas Link|EWL|tuas link mrt"

  # Changi Airport Branch
  "CG1|Expo|EWL|expo mrt"
  "CG2|Changi Airport|EWL|changi airport mrt"

  # North-East Line
  "NE1|HarbourFront|NEL|harbourfront mrt"
  "NE3|Outram Park|NEL|outram park mrt"
  "NE4|Chinatown|NEL|chinatown mrt"
  "NE5|Clarke Quay|NEL|clarke quay mrt"
  "NE6|Dhoby Ghaut|NEL|dhoby ghaut mrt"
  "NE7|Little India|NEL|little india mrt"
  "NE8|Farrer Park|NEL|farrer park mrt"
  "NE9|Boon Keng|NEL|boon keng mrt"
  "NE10|Potong Pasir|NEL|potong pasir mrt"
  "NE11|Woodleigh|NEL|woodleigh mrt"
  "NE12|Serangoon|NEL|serangoon mrt"
  "NE13|Kovan|NEL|kovan mrt"
  "NE14|Hougang|NEL|hougang mrt"
  "NE15|Buangkok|NEL|buangkok mrt"
  "NE16|Sengkang|NEL|sengkang mrt"
  "NE17|Punggol|NEL|punggol mrt"
  "NE18|Punggol Coast|NEL|punggol coast mrt"

  # Circle Line
  "CC1|Dhoby Ghaut|CCL|dhoby ghaut mrt"
  "CC2|Bras Basah|CCL|bras basah mrt"
  "CC3|Esplanade|CCL|esplanade mrt"
  "CC4|Promenade|CCL|promenade mrt"
  "CC5|Nicoll Highway|CCL|nicoll highway mrt"
  "CC6|Stadium|CCL|stadium mrt"
  "CC7|Mountbatten|CCL|mountbatten mrt"
  "CC8|Dakota|CCL|dakota mrt"
  "CC9|Paya Lebar|CCL|paya lebar mrt"
  "CC10|MacPherson|CCL|macpherson mrt"
  "CC11|Tai Seng|CCL|tai seng mrt"
  "CC12|Bartley|CCL|bartley mrt"
  "CC13|Serangoon|CCL|serangoon mrt"
  "CC14|Lorong Chuan|CCL|lorong chuan mrt"
  "CC15|Bishan|CCL|bishan mrt"
  "CC16|Marymount|CCL|marymount mrt"
  "CC17|Caldecott|CCL|caldecott mrt"
  "CC19|Botanic Gardens|CCL|botanic gardens mrt"
  "CC20|Farrer Road|CCL|farrer road mrt"
  "CC21|Holland Village|CCL|holland village mrt"
  "CC22|Buona Vista|CCL|buona vista mrt"
  "CC23|one-north|CCL|one-north mrt"
  "CC24|Kent Ridge|CCL|kent ridge mrt"
  "CC25|Haw Par Villa|CCL|haw par villa mrt"
  "CC26|Pasir Panjang|CCL|pasir panjang mrt"
  "CC27|Labrador Park|CCL|labrador park mrt"
  "CC28|Telok Blangah|CCL|telok blangah mrt"
  "CC29|HarbourFront|CCL|harbourfront mrt"

  # Circle Line Extension
  "CE1|Bayfront|CCL|bayfront mrt"
  "CE2|Marina Bay|CCL|marina bay mrt"

  # Downtown Line
  "DT1|Bukit Panjang|DTL|bukit panjang mrt"
  "DT2|Cashew|DTL|cashew mrt"
  "DT3|Hillview|DTL|hillview mrt"
  "DT4|Hume|DTL|hume mrt"
  "DT5|Beauty World|DTL|beauty world mrt"
  "DT6|King Albert Park|DTL|king albert park mrt"
  "DT7|Sixth Avenue|DTL|sixth avenue mrt"
  "DT8|Tan Kah Kee|DTL|tan kah kee mrt"
  "DT9|Botanic Gardens|DTL|botanic gardens mrt"
  "DT10|Stevens|DTL|stevens mrt"
  "DT11|Newton|DTL|newton mrt"
  "DT12|Little India|DTL|little india mrt"
  "DT13|Rochor|DTL|rochor mrt"
  "DT14|Bugis|DTL|bugis mrt"
  "DT15|Promenade|DTL|promenade mrt"
  "DT16|Bayfront|DTL|bayfront mrt"
  "DT17|Downtown|DTL|downtown mrt"
  "DT18|Telok Ayer|DTL|telok ayer mrt"
  "DT19|Chinatown|DTL|chinatown mrt"
  "DT20|Fort Canning|DTL|fort canning mrt"
  "DT21|Bencoolen|DTL|bencoolen mrt"
  "DT22|Jalan Besar|DTL|jalan besar mrt"
  "DT23|Bendemeer|DTL|bendemeer mrt"
  "DT24|Geylang Bahru|DTL|geylang bahru mrt"
  "DT25|Mattar|DTL|mattar mrt"
  "DT26|MacPherson|DTL|macpherson mrt"
  "DT27|Ubi|DTL|ubi mrt"
  "DT28|Kaki Bukit|DTL|kaki bukit mrt"
  "DT29|Bedok North|DTL|bedok north mrt"
  "DT30|Bedok Reservoir|DTL|bedok reservoir mrt"
  "DT31|Tampines West|DTL|tampines west mrt"
  "DT32|Tampines|DTL|tampines mrt"
  "DT33|Tampines East|DTL|tampines east mrt"
  "DT34|Upper Changi|DTL|upper changi mrt"
  "DT35|Expo|DTL|expo mrt"

  # Thomson-East Coast Line
  "TE1|Woodlands North|TEL|woodlands north mrt"
  "TE2|Woodlands|TEL|woodlands mrt"
  "TE3|Woodlands South|TEL|woodlands south mrt"
  "TE4|Springleaf|TEL|springleaf mrt"
  "TE5|Lentor|TEL|lentor mrt"
  "TE6|Mayflower|TEL|mayflower mrt"
  "TE7|Bright Hill|TEL|bright hill mrt"
  "TE8|Upper Thomson|TEL|upper thomson mrt"
  "TE9|Caldecott|TEL|caldecott mrt"
  "TE11|Stevens|TEL|stevens mrt"
  "TE12|Napier|TEL|napier mrt"
  "TE13|Orchard Boulevard|TEL|orchard boulevard mrt"
  "TE14|Orchard|TEL|orchard mrt"
  "TE15|Great World|TEL|great world mrt"
  "TE16|Havelock|TEL|havelock mrt"
  "TE17|Outram Park|TEL|outram park mrt"
  "TE18|Maxwell|TEL|maxwell mrt"
  "TE19|Shenton Way|TEL|shenton way mrt"
  "TE20|Marina Bay|TEL|marina bay mrt"
  "TE22|Gardens by the Bay|TEL|gardens by the bay mrt"
  "TE23|Tanjong Rhu|TEL|tanjong rhu mrt"
  "TE24|Katong Park|TEL|katong park mrt"
  "TE25|Tanjong Katong|TEL|tanjong katong mrt"
  "TE26|Marine Parade|TEL|marine parade mrt"
  "TE27|Marine Terrace|TEL|marine terrace mrt"
  "TE28|Siglap|TEL|siglap mrt"
  "TE29|Bayshore|TEL|bayshore mrt"

  # Bukit Panjang LRT
  "BP1|Choa Chu Kang|BPL|choa chu kang lrt"
  "BP2|South View|BPL|south view lrt"
  "BP3|Keat Hong|BPL|keat hong lrt"
  "BP4|Teck Whye|BPL|teck whye lrt"
  "BP5|Phoenix|BPL|phoenix lrt"
  "BP6|Bukit Panjang|BPL|bukit panjang lrt"
  "BP7|Petir|BPL|petir lrt"
  "BP8|Pending|BPL|pending lrt"
  "BP9|Bangkit|BPL|bangkit lrt"
  "BP10|Fajar|BPL|fajar lrt"
  "BP11|Segar|BPL|segar lrt"
  "BP12|Jelapang|BPL|jelapang lrt"
  "BP13|Senja|BPL|senja lrt"

  # Sengkang LRT
  "STC|Sengkang|SKL|sengkang lrt"
  "SW1|Cheng Lim|SKL|cheng lim lrt"
  "SW2|Farmway|SKL|farmway lrt"
  "SW3|Kupang|SKL|kupang lrt"
  "SW4|Thanggam|SKL|thanggam lrt"
  "SW5|Fernvale|SKL|fernvale lrt"
  "SW6|Layar|SKL|layar lrt"
  "SW7|Tongkang|SKL|tongkang lrt"
  "SW8|Renjong|SKL|renjong lrt"
  "SE1|Compassvale|SKL|compassvale lrt"
  "SE2|Rumbia|SKL|rumbia lrt"
  "SE3|Bakau|SKL|bakau lrt"
  "SE4|Kangkar|SKL|kangkar lrt"
  "SE5|Ranggung|SKL|ranggung lrt"

  # Punggol LRT
  "PTC|Punggol|PGL|punggol lrt"
  "PW1|Sam Kee|PGL|sam kee lrt"
  "PW3|Soo Teck|PGL|soo teck lrt"
  "PW4|Teck Lee|PGL|teck lee lrt"
  "PW5|Punggol Point|PGL|punggol point lrt"
  "PW6|Samudera|PGL|samudera lrt"
  "PW7|Nibong|PGL|nibong lrt"
  "PE1|Cove|PGL|cove lrt"
  "PE2|Meridian|PGL|meridian lrt"
  "PE3|Coral Edge|PGL|coral edge lrt"
  "PE4|Riviera|PGL|riviera lrt"
  "PE5|Kadaloor|PGL|kadaloor lrt"
  "PE6|Oasis|PGL|oasis lrt"
  "PE7|Damai|PGL|damai lrt"
)

echo "→ Geocoding ${#STATIONS[@]} stations via OneMap Search API..."
echo "  (takes 3-5 min; sleeping 500ms between calls to be polite)"
echo ""

mkdir -p data
TMP=$(mktemp)
trap "rm -f $TMP" EXIT
echo "[" > "$TMP"
FIRST=1
FAILED=0

for entry in "${STATIONS[@]}"; do
  IFS='|' read -r code name line query <<< "$entry"
  q=$(printf '%s' "$query" | jq -sRr @uri)
  url="https://www.onemap.gov.sg/api/common/elastic/search?searchVal=${q}&returnGeom=Y&getAddrDetails=N&pageNum=1"

  resp=$(curl -sS --max-time 15 "$url" 2>/dev/null || echo '{}')
  # Pick the first result whose SEARCHVAL contains "STATION"
  coords=$(echo "$resp" | jq -r '[.results[]? | select(.SEARCHVAL|ascii_upcase|contains("STATION"))][0] | if . then "\(.LATITUDE),\(.LONGITUDE)" else "null,null" end' 2>/dev/null || echo "null,null")

  if [[ "$coords" == "null,null" || -z "$coords" ]]; then
    echo "  ✗ ${code} ${name} (${query})"
    FAILED=$((FAILED + 1))
    sleep 0.5
    continue
  fi

  lat=$(echo "$coords" | cut -d, -f1)
  lng=$(echo "$coords" | cut -d, -f2)
  lat_r=$(printf "%.5f" "$lat")
  lng_r=$(printf "%.5f" "$lng")

  if [[ $FIRST -eq 1 ]]; then
    FIRST=0
  else
    echo "," >> "$TMP"
  fi
  printf '["%s","%s","%s",%s,%s]' "$code" "$name" "$line" "$lat_r" "$lng_r" >> "$TMP"

  echo "  ✓ ${code} ${name} → ${lat_r},${lng_r}"
  sleep 0.5
done

echo "" >> "$TMP"
echo "]" >> "$TMP"

TOTAL=$((${#STATIONS[@]} - FAILED))
jq -n \
  --arg note "Full Singapore MRT/LRT network generated by scripts/build-stations.sh" \
  --arg source "OneMap Search API" \
  --arg version "full-v1-$(date +%Y-%m-%d)" \
  --argjson stations "$(cat $TMP)" \
  '{_note: $note, _source: $source, _version: $version, _format: "[code, name, line, lat, lng]", stations: $stations}' \
  > data/stations.json

echo ""
echo "✓ Wrote data/stations.json ($TOTAL stations, $FAILED failed)"
if [[ $FAILED -gt 0 ]]; then
  echo "  ($FAILED stations failed to geocode. Retry or check the entries"
  echo "   marked ✗ above — OneMap may need a more specific search string.)"
fi
echo "  Restart proxy.py to pick up the new dataset."
