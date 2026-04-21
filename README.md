# Kufai WhatsApp Menu Extractor

A Node.js tool that connects to WhatsApp Web, reads image messages from a specified chat, and extracts them — along with their captions — into a structured JSON file ready to import into Kufai's Menu Builder.

---

## Table of Contents

- [What This Does](#what-this-does)
- [How It Works](#how-it-works)
  - [Architecture & Flow](#architecture--flow)
  - [Caption Format](#caption-format)
  - [Output Structure](#output-structure)
- [Prerequisites](#prerequisites)
- [Installation & Setup](#installation--setup)
- [Configuration](#configuration)
  - [Environment Variables Reference](#environment-variables-reference)
- [Usage](#usage)
- [Status API](#status-api)
- [Output Files](#output-files)
- [Troubleshooting](#troubleshooting)
- [Developer Notes](#developer-notes)
  - [Code Structure](#code-structure)
  - [Tuning for Performance](#tuning-for-performance)
  - [Known Limitations](#known-limitations)

---

## What This Does

Restaurant owners or catalogue managers often share menu items as images with captions in a WhatsApp chat. This tool automates the tedious task of collecting all those images and building a structured menu catalogue from them.

It:
1. Opens WhatsApp Web in a Chromium browser and authenticates via QR code scan.
2. Finds a specified chat by phone number (or falls back to searching by name).
3. Scrolls back through the chat history to load a target number of messages.
4. Downloads every image message and parses its caption for the item name and price.
5. Saves the results as `menu_items.json` (with embedded base64 images) and `menu_items_paths.json` (paths only), ready to import into Kufai's Menu Builder.
6. Runs a small Express server so other tools can poll `/status` to know when extraction is complete.

---

## How It Works

### Architecture & Flow

```
node main.js
│
├─ Express server starts on PORT (default 3000)
│   └─ GET /status → returns { status, itemCount }
│
├─ WhatsApp client initialises (Puppeteer + whatsapp-web.js)
│   └─ QR code printed to terminal → user scans with phone
│
├─ On 'ready':
│   └─ extractMenuItems()
│         │
│         ├─ 1. getChatById(TARGET_NUMBER)
│         │       └─ fallback: search all chats by CONTACT_NAME
│         │
│         ├─ 2. Click chat open in WhatsApp Web DOM
│         │
│         ├─ 3. scrollToLoadMessages(page, FETCH_TARGET)
│         │       └─ Scrolls to top repeatedly, counting DOM message nodes
│         │           until FETCH_TARGET reached or MAX_SCROLL_ATTEMPTS hit
│         │           with NO_CHANGE_THRESHOLD consecutive empty scrolls
│         │
│         ├─ 4. triggerInfiniteScroll() (if step 3 didn't reach target)
│         │
│         ├─ 5. chat.fetchMessages({ limit: FETCH_TARGET })
│         │       └─ fallback: chat.loadEarlierMessages() × LOAD_EARLIER_RETRIES
│         │
│         ├─ 6. Filter to image messages only
│         │
│         ├─ 7. For each image:
│         │       ├─ msg.downloadMedia()
│         │       ├─ Save image file to OUTPUT_DIR/images/
│         │       ├─ Parse caption → name + price
│         │       └─ Push to menuItems[]
│         │           (pause BATCH_SLEEP_MS every BATCH_SIZE images)
│         │
│         └─ 8. Write menu_items.json and menu_items_paths.json
│
└─ process.exit(0)
```

### Caption Format

The script reads the caption attached to each image message. It splits on the `@` character:

```
Chicken Tikka Masala@850
│                    │
itemName             itemPrice  (prefixed with CURRENCY, default "Ksh")
```

If there is no `@` in the caption, the entire caption is used as the item name and the price is left blank. If there is no caption at all, the item is named `"Unnamed Item"`.

### Output Structure

```
kufai_output/                        ← OUTPUT_DIR
├── images/
│   ├── item_0_1712345678901.jpg
│   ├── item_1_1712345678999.jpg
│   └── …
├── menu_items.json                  ← full export with base64 imageUrl
└── menu_items_paths.json            ← lightweight export with imagePath only
```

---

## Prerequisites

- **Node.js 18+** (LTS recommended)
- **Google Chrome** or **Chromium** installed on your machine
- A **WhatsApp account** with access to the target chat
- The chat must contain image messages with captions in the `Name@Price` format (or plain captions)

---

## Installation & Setup

**1. Clone or download the repository**
```bash
git clone <your-repo-url>
cd <repo-folder>
```

**2. Install Node dependencies**
```bash
npm install
```

This installs:
- `express` — status API server
- `whatsapp-web.js` — WhatsApp Web automation
- `qrcode-terminal` — renders the QR code in the terminal
- `dotenv` *(optional but recommended)* — loads `.env` files

**3. Configure your environment**

Copy the example env file and fill in your values:
```bash
cp .env.example .env
```

At minimum, set `TARGET_NUMBER` and `CONTACT_NAME` in `.env`. All other values have sensible defaults. See the [Configuration](#configuration) section for full details.

---

## Configuration

All configuration is done through environment variables. The script loads them from a `.env` file in the project root if one exists (requires `dotenv`), and falls back to process environment variables otherwise.

**Never commit your `.env` file to version control.** Add it to `.gitignore`.

You can also pass variables inline without a `.env` file:
```bash
TARGET_NUMBER=254712345678 CONTACT_NAME="My Chat" node main.js
```

### Environment Variables Reference

| Variable | Default | Required | Description |
|---|---|---|---|
| `TARGET_NUMBER` | `254750410008` | **Yes** | Phone number of the WhatsApp contact or group to scrape. Digits only — no `+`, spaces, or `@c.us` suffix. |
| `CONTACT_NAME` | `Kungu Meru WhatsApp` | **Yes** | Display name of the chat. Used as fallback if the number lookup fails. |
| `PORT` | `3000` | No | Port for the Express status server. |
| `FETCH_TARGET` | `120` | No | How many messages to load from chat history. Increase for longer catalogues. |
| `OUTPUT_DIR` | `kufai_output` | No | Folder where images and JSON are saved. Can be an absolute or relative path. |
| `CURRENCY` | `Ksh` | No | Currency prefix prepended to prices (e.g. `Ksh 850`). Change to `USD`, `EUR`, etc. as needed. |
| `HEADLESS` | `false` | No | Run Chrome with no visible window. Set to `true` on headless servers or CI environments. |
| `MAX_SCROLL_ATTEMPTS` | `50` | No | Maximum scroll steps when trying to load older messages. |
| `SCROLL_PAUSE_MS` | `2000` | No | Milliseconds to wait between scroll steps. Increase on slow connections. |
| `PLAY_WAIT_MS` | `3000` | No | Milliseconds to wait for the chat or player UI to finish loading. |
| `BATCH_SIZE` | `10` | No | Number of images to download before pausing. |
| `BATCH_SLEEP_MS` | `300` | No | Milliseconds to pause between batches. |
| `LOAD_EARLIER_RETRIES` | `5` | No | Number of `loadEarlierMessages()` calls if `fetchMessages` returns too few results. |
| `NO_CHANGE_THRESHOLD` | `5` | No | Stop scrolling after this many consecutive scroll attempts with no new messages. |

---

## Usage

**1. Start the extractor**
```bash
node main.js
```

**2. Scan the QR code**

A QR code will appear in the terminal. Open WhatsApp on your phone, go to **Linked Devices → Link a Device**, and scan the code. You only need to do this once — the session is saved in `.wwebjs_auth/` and reused on subsequent runs.

**3. Wait for extraction to complete**

The script will log its progress:
```
Client ready. Starting extraction…
Found chat by number: "Kungu Meru WhatsApp"
Attempting to load 120 messages...
Starting scroll-based message loading...
   Scroll attempt 1: 42 messages
   Scroll attempt 2: 87 messages
   ...
Image messages found: 34
34/34   33   1
Done — Processed: 33  |  Skipped: 1
/home/user/project/kufai_output
   • menu_items.json        ← import into Kufai's Menu Builder
   • menu_items_paths.json  ← paths-only reference
   • images/                ← 33 files
Done! Import menu_items.json into the menu builder.
```

**4. Import the output**

Upload `kufai_output/menu_items.json` into Kufai's Menu Builder.

---

## Status API

While the script is running, a lightweight Express server is available at `http://localhost:PORT`. This allows other services or scripts to poll for completion.

**`GET /status`**

Returns JSON indicating whether extraction is complete:

```json
// Still running (menu_items.json not yet written)
{ "status": "pending", "itemCount": 0 }

// Extraction complete
{ "status": "ready", "itemCount": 33 }
```

The server also serves the `OUTPUT_DIR` as static files, so images can be accessed at `http://localhost:PORT/images/<filename>` once extraction is done.

---

## Output Files

| File | Description |
|---|---|
| `menu_items.json` | Full menu catalogue. Each item includes `name`, `category`, `price`, `imagePath`, and `imageUrl` (base64-encoded). Use this to import into Kufai's Menu Builder. |
| `menu_items_paths.json` | Same as above but with `imageUrl` omitted. Useful as a lightweight reference or for logging. |
| `images/` | Raw image files saved as `item_N_<timestamp>.<ext>`. |
| `.wwebjs_auth/` | WhatsApp session data (auto-generated). Keep this to avoid re-scanning the QR code on subsequent runs. Delete it to force a fresh login. |

---

## Troubleshooting

**QR code not appearing**
Make sure Chrome/Chromium is installed. If `HEADLESS=true` is set but you need to scan a QR code, set it to `false` first. The QR code is only needed once — after that, the session is cached.

**`Auth failed — delete .wwebjs_auth and retry`**
Delete the `.wwebjs_auth/` folder in the project root and re-run. You'll need to scan the QR code again.

**`Chat not found`**
Double-check `TARGET_NUMBER` (digits only, no `+` or spaces) and `CONTACT_NAME`. Both are used as search criteria. The number must be in your WhatsApp contacts or active chats.

**Fewer messages than expected**
Increase `FETCH_TARGET` and/or `MAX_SCROLL_ATTEMPTS`. On slow connections, also increase `SCROLL_PAUSE_MS` and `PLAY_WAIT_MS` to give WhatsApp Web more time to load content between scrolls.

**Images are skipping (`⏭` count is high)**
Some messages may have expired media or network errors during download. These are logged with ` Skipped:` and the error reason. Re-running is safe — it will re-attempt all images each run.

**Chrome crashes or `--no-sandbox` error**
This typically happens on Linux servers. The script already passes `--no-sandbox` and `--disable-setuid-sandbox` by default, which covers most server environments.

**Port already in use**
Change the port via the `PORT` environment variable: `PORT=4000 node main.js`.

---

## Developer Notes

### Code Structure

```
main.js
│
├─ Config block          — reads all env vars with defaults
├─ Output paths          — resolves OUTPUT_DIR, IMAGES_DIR, JSON_OUT_FILE
├─ WhatsApp client       — sets up event handlers (qr, authenticated, ready)
├─ sleep()               — simple promise-based delay helper
│
├─ scrollToLoadMessages(page, targetCount)
│     Polls the DOM for message count, scrolls to top repeatedly until
│     targetCount is reached or scroll attempts are exhausted.
│
├─ triggerInfiniteScroll(page)
│     Fallback: fires rapid scroll-to-top events to nudge WhatsApp Web's
│     own lazy loader into action.
│
├─ extractMenuItems()    — main orchestrator (7 steps, see flow diagram above)
│
└─ Express server        — GET /status + static file serving
```

### Tuning for Performance

| Scenario | Recommended change |
|---|---|
| Large catalogue (200+ images) | Increase `FETCH_TARGET` to `250` or more |
| Slow or mobile hotspot connection | Increase `SCROLL_PAUSE_MS` to `3000–4000` and `PLAY_WAIT_MS` to `5000` |
| Running on a headless server | Set `HEADLESS=true` after the first QR scan (session is cached) |
| Rate limiting / download errors | Decrease `BATCH_SIZE` to `5` and increase `BATCH_SLEEP_MS` to `500` |
| Chat with very old messages | Increase `MAX_SCROLL_ATTEMPTS` to `100` and `LOAD_EARLIER_RETRIES` to `10` |

### Known Limitations

- **WhatsApp Web DOM selectors may break** if WhatsApp updates its web interface. The selectors in `scrollToLoadMessages` target `data-testid` attributes and `data-tab` values that can change without notice.
- **Media expiry**: WhatsApp media URLs expire. The script downloads media immediately during extraction, so as long as the message is recent enough for WhatsApp to still serve the file, it will work.
- **One session at a time**: Running two instances against the same WhatsApp account will invalidate the first session. Keep only one instance running.
- **Groups vs. contacts**: The script works with both group chats and individual contacts. For groups, use the group's phone-number ID as `TARGET_NUMBER` or rely on `CONTACT_NAME` matching.
- **Category is always `"General"`**: The script does not infer categories from captions. Category assignment would need to be done in Kufai's Menu Builder after import, or by extending the caption format (e.g. `Name@Price@Category`).
