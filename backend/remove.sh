#!/usr/bin/env bash
# Remove what deploy.sh created, by exact SID: the stackchan-event Service and its Sync Service (all claim data).
# Then put the number's SMS webhook back to what it was before deploy.sh, and delete .deploy/event.
set -euo pipefail
cd "$(dirname "$0")/.."
D=.deploy/event
[ -d "$D" ] || { echo "Nothing to remove ($D not found)."; exit 0; }
val() { grep "^$1=" "$D/.env" 2>/dev/null | cut -d= -f2- || true; }
field() { node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]])' "$D/number-before.json" "$1"; }
if [ -f "$D/number-before.json" ]; then
  N=$(field sid)
  if [ -n "$(field smsApplicationSid)" ]; then
    twilio api:core:incoming-phone-numbers:update --sid "$N" --sms-application-sid "$(field smsApplicationSid)" > /dev/null
  else
    twilio api:core:incoming-phone-numbers:update --sid "$N" --sms-url "$(field smsUrl)" --sms-method "$(field smsMethod)" > /dev/null
  fi
  echo "Restored the number's SMS webhook."
fi
if [ -f "$D/.twiliodeployinfo" ]; then
  SID=$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(Object.values(j)[0].serviceSid)' "$D/.twiliodeployinfo")
  twilio api:serverless:v1:services:remove --sid "$SID" && echo "Removed Service $SID"
fi
S=$(val SYNC_SERVICE_SID); [ -z "$S" ] || { twilio api:sync:v1:services:remove --sid "$S" && echo "Removed Sync Service $S"; }
rm -rf "$D"; echo "Deleted $D"
