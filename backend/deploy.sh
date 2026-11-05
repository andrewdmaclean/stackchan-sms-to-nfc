#!/usr/bin/env bash
# Deploy the event claim backend with the Twilio CLI's active profile (no credential files are read).
# Creates once, then reuses: Serverless Service "stackchan-event", a Sync Service with the event_requests,
# event_claim_tokens and event_stats (cards per day) maps, and the robot's device token. Points only the number's SMS webhook at /sms; its voice
# webhook is unchanged. Secrets stay in .deploy/event/.env (git-ignored). Undo everything: npm run remove
# Usage: npm run deploy -- +15555550100   (your Twilio number)
# Finishes by writing robot/config.js for this backend (scripts/robot-config.cjs).
set -euo pipefail
cd "$(dirname "$0")/.."
PHONE=${1:?Usage: npm run deploy -- +1YOURNUMBER   (the Twilio number guests will text)}
D=.deploy/event; SRC=backend
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const x=Array.isArray(j)?j[0]:j;process.stdout.write(x?String(x[process.argv[1]]??""):"")})' "$1"; }
random() { node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("base64url"))'; }
has() { grep -q "^$1=" "$D/.env"; }
val() { grep "^$1=" "$D/.env" | cut -d= -f2-; }

mkdir -p "$D"; touch "$D/.env"; chmod 600 "$D/.env"
NUMBER_SID=$(twilio api:core:incoming-phone-numbers:list --phone-number "$PHONE" -o json | json sid)
[ -n "$NUMBER_SID" ] || { echo "$PHONE is not a number on this account"; exit 1; }
# What the number's SMS pointed at before, so remove.sh can put it back.
if [ ! -f "$D/number-before.json" ]; then
  twilio api:core:incoming-phone-numbers:fetch --sid "$NUMBER_SID" -o json \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const n=JSON.parse(s)[0];console.log(JSON.stringify({sid:n.sid,smsUrl:n.smsUrl||"",smsMethod:n.smsMethod||"POST",smsApplicationSid:n.smsApplicationSid||""}))})' > "$D/number-before.json"
fi
if ! has SYNC_SERVICE_SID; then
  echo "Creating Sync Service…"
  echo "SYNC_SERVICE_SID=$(twilio api:sync:v1:services:create --friendly-name stackchan-event -o json | json sid)" >> "$D/.env"
fi
SYNC=$(val SYNC_SERVICE_SID)
for MAP in event_requests event_claim_tokens event_stats; do
  twilio api:sync:v1:services:maps:fetch --service-sid "$SYNC" --sid "$MAP" > /dev/null 2>&1 \
    || twilio api:sync:v1:services:maps:create --service-sid "$SYNC" --unique-name "$MAP" > /dev/null
done
has EVENT_DEVICE_TOKEN || echo "EVENT_DEVICE_TOKEN=$(random)" >> "$D/.env"
has EVENT_TIMEZONE || echo "EVENT_TIMEZONE=America/Vancouver" >> "$D/.env" # which day a card counts toward
has EVENT_MMS || echo "EVENT_MMS=on" >> "$D/.env" # send the QR as an MMS picture; off = link only
has EVENT_THANK_YOU_SMS || echo "EVENT_THANK_YOU_SMS=on" >> "$D/.env" # set to off to stop thank-you texts
has EVENT_TWILIO_NUMBER || echo "EVENT_TWILIO_NUMBER=$PHONE" >> "$D/.env"
[ "$(val EVENT_TWILIO_NUMBER)" = "$PHONE" ] || { echo "$D/.env is set up for $(val EVENT_TWILIO_NUMBER); run npm run remove first"; exit 1; }

echo "Building…"
rm -rf "$D/functions"; mkdir -p "$D/functions"
cp -R "$SRC/functions/." "$D/functions/"
cp "$SRC/store.cjs" "$D/functions/store.private.js"
cp "$SRC/handlers.cjs" "$D/functions/event.private.js"
cat > "$D/package.json" <<'JSON'
{ "name": "stackchan-event", "private": true, "dependencies": { "@twilio/runtime-handler": "2.1.2", "qrcode": "1.5.4" } }
JSON

echo "Deploying…"
twilio serverless:deploy --cwd "$D" --service-name stackchan-event --runtime node24 --production > "$D/deploy.log" 2>&1 || { tail -20 "$D/deploy.log"; exit 1; }
SID=$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(Object.values(j)[0].serviceSid)' "$D/.twiliodeployinfo")
DOMAIN=$(twilio api:serverless:v1:services:environments:list --service-sid "$SID" -o json | json domainName)
echo "{\"serviceSid\":\"$SID\",\"domain\":\"$DOMAIN\",\"phone\":\"$PHONE\"}" > "$D/service.json"
twilio api:core:incoming-phone-numbers:update --sid "$NUMBER_SID" --sms-url "https://$DOMAIN/sms" --sms-method POST > /dev/null
N=$(twilio api:core:incoming-phone-numbers:fetch --sid "$NUMBER_SID" -o json)
[ -z "$(echo "$N" | json smsApplicationSid)" ] || echo "Note: $PHONE has an SMS app set, which wins over its SMS URL."
node scripts/robot-config.cjs
cat <<DONE

Backend live: https://$DOMAIN
Texts to $PHONE now get a claim QR. Next: npm run build
DONE
