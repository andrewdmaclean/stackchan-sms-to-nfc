# StackChan SMS to NFC

Twill is a StackChan robot for a conference booth. Visitors text a link to a phone number, and Twill writes
that link onto an NFC card they can take home. Tapping the card on a phone opens the link.

## What happens at the booth

1. Twill looks around. Every few seconds its screen shows a QR code: **"Scan me to text your link!"**
2. The visitor scans it, texts their link, and gets a picture message back with their own QR code.
3. They tap an NFC card on Twill. Twill shows what's on the card, then asks **"Show me your QR code!"**
4. They hold up their phone. Twill reads the code and writes their link to the card (tap again if asked).
5. Twill celebrates, and the visitor gets a thank-you text. Then Twill waits for the next person.

## What you need

- **The robot:** an M5Stack StackChan (the CoreS3 robot with the StackChan body) and a USB-C **data** cable.
- **Cards:** writable NFC cards or stickers of type **NTAG213, NTAG215 or NTAG216**.
- **A computer:** Mac or Windows with [Node.js](https://nodejs.org) 22 or newer and Google Chrome.
- **A Twilio account** with a phone number that can send text and picture messages (SMS and MMS).
  US numbers must be registered for A2P 10DLC before they can text US phones.
- **The Twilio command-line tool**, signed in, with its Serverless plugin. In a terminal:
  ```sh
  brew tap twilio/brew && brew install twilio     # Windows and others: https://www.twilio.com/docs/twilio-cli
  twilio login
  twilio plugins:install @twilio-labs/plugin-serverless
  ```

## Get it running

Run these from this folder in a terminal.

**1. Install the tools** (once; downloads about 1 GB):

```sh
npm install
npm run setup
```

**2. Put the backend on Twilio** (use your Twilio number):

```sh
npm run deploy -- +15555550100
```

This sets up the Twilio side and points that number's text messages at it. It also configures the robot's
software to talk to it. Its voice calls are not changed.

**3. Build Twill's software:**

```sh
npm run build
```

**4. Open the StackChan tools** and leave this running:

```sh
npm start
```

**5. Prepare the robot** (first time only). Plug Twill into the computer with the USB-C cable, then in Chrome:

- If Twill has never had StackChan community firmware, install it at <http://127.0.0.1:5173/flash/> (choose
  **M5StackChan CoreS3**). This erases the robot's settings.
- Set Twill's Wi-Fi at <http://127.0.0.1:5173/preference/>. At an event, use your own phone hotspot: Wi-Fi with
  a sign-in page stops Twill reaching Twilio.

**6. Install Twill's software:** open <http://127.0.0.1:5173/mod-gallery/?mod=local.stackchan.sms-to-nfc> and
choose **Write to device**. Do this again whenever you rebuild (refresh the page first).

**7. Try it:** wait for the QR on Twill's screen, scan it with your phone, text any `https://` link, then tap a
card, show the picture you get back (tap it to make it full screen, about 10-20 cm from Twill's face), and tap
the card again if asked.

## At the event

- Plug Twill into USB power and use a hotspot you control.
- Do one full test (text, tap, scan, write) after setting up.
- Bring spare NTAG cards. Cards can be rewritten.
- Staff controls are behind the **menu** button at the top of Twill's screen (**Scan / retry**, **Stop
  event**). Visitors never need them.
- Every reply and thank-you is a normal outgoing message; picture messages cost more than plain texts.

## If something goes wrong

| What you see | What to do |
| --- | --- |
| Twill shows the normal StackChan face, not the red one | The software didn't install or load. Run `npm run build` and install again. |
| Twill restarts | When it comes back it shows "Reset at: ..." with the step it was on. Note it (and see the log below). |
| The QR on the phone isn't read | Hold the phone 10-20 cm from Twill's face, screen brightness up, QR filling the screen. |
| "Hold it still and tap again!" | Writing needs the card held flat and still. The visitor doesn't need to show the QR again. |
| "That card is locked." / "I can't use that card." | Use a writable NTAG213/215/216 card. Hotel keys, badges and bank cards don't work. |
| You want Twill back to normal | At <http://127.0.0.1:5173/editor/> choose **Remove device MOD**. |

To see what Twill is doing (Mac), close the install page first, then: `cat /dev/cu.usbmodem* | tee twill.log`

## Optional settings

**Backend**, in `.deploy/event/.env` (run `npm run deploy -- +15555550100` again to apply):

| Setting | Default | What it does |
| --- | --- | --- |
| `EVENT_MMS` | `on` | Send the QR as a picture. `off` sends a link to a QR web page instead. |
| `EVENT_THANK_YOU_SMS` | `on` | Text the visitor their link and card number after writing. |
| `EVENT_TIMEZONE` | `America/Vancouver` | Which day a card counts toward ("card #N today"). |
| `EVENT_ALLOWED_SENDERS` | anyone | Comma-separated phone numbers allowed to use it. |

**Robot**, in `robot/config.js` (then `npm run build` and install again): `napAfterSeconds` (180),
`scanTimeoutSeconds` (30), `motion` (`false` keeps the head still), `enableNFCWrite` (`false` tests scanning
without writing cards). See `robot/config.example.js`.

## How it works

There are two parts:

- **`robot/`**: the software that runs on Twill. It's a StackChan **MOD**, an add-on installed on top of the
  standard StackChan firmware (no custom firmware). It runs the camera, NFC reader, head and face. QR codes
  are read on the robot, and no camera images leave it.
- **`backend/`**: the Twilio side (Serverless Functions, with Sync as storage). It receives the texts, sends
  the QR pictures, gives Twill the link when it reads a code, numbers each card and sends the thank-you.

| Step | What happens |
| --- | --- |
| Visitor texts a link | The backend saves it with a random one-time code and replies with that code as a QR picture. |
| Twill reads the QR | Twill sends the code to the backend and gets the link, reserved for this robot for 2 minutes. |
| Card written and checked | Twill tells the backend, which records the card and texts the visitor. |

The QR code holds only the one-time code, never the link or the phone number. Codes expire after 24 hours.

## For developers

```sh
npm test           # tests
npm run test:xs    # Twill's QR decoder in Moddable's XS engine (needs an xst binary in .cache/qr-js/)
```

| Folder | Contents |
| --- | --- |
| `robot/` | The MOD: `mod.js` (screens, timing, faces), `controller.js` (card and QR flow), `look-around.js` (head), `text-me-screen.js`, `qr-decoder.js`, `http.js`, and `vendor/` (QR decoder, NFC driver, certificate) |
| `backend/` | `handlers.cjs` and `store.cjs` (logic and storage), `functions/` (the Twilio Functions), `deploy.sh`, `remove.sh` |
| `scripts/` | What the npm commands run |
| `tests/` | Tests |
| `upstream/stack-chan/` | The StackChan community tools, downloaded by `npm run setup` (not part of this repo) |

The StackChan simulator (<http://127.0.0.1:5173/simulator/>) runs the real firmware but has no NFC reader, so
set `enableNFCWrite: false` in `robot/config.js` to try a build there.

Every message bubble on Twill's screen is limited to 28 characters: longer text makes the firmware run out of
drawing space and restart.

## Keep private

`.deploy/event/.env`, `robot/config.js`, the built file in `.artifacts/` and its copy in the StackChan tools
(`upstream/stack-chan/web/mod-gallery/samples/sms-to-nfc/`) contain the robot's access token. They are already
excluded from git.

## Take it all down

```sh
npm run remove
```

This deletes the Twilio services (and all saved requests) and gives the phone number back its previous text
message setting.
