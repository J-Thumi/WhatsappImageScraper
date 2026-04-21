const express = require('express');
const app = express();
const QRCode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');

// ── Load .env file if present (npm install dotenv) ────────────────────────────
try { require('dotenv').config(); } catch (_) { /* dotenv is optional */ }

// ── Config (all values can be set via environment variables) ──────────────────
//
//  Copy .env.example to .env and fill in your values, e.g.:
//
//    PORT=3000
//    TARGET_NUMBER=254712345678        # digits only — no @c.us suffix needed
//    CONTACT_NAME=My WhatsApp Contact
//    FETCH_TARGET=120
//    OUTPUT_DIR=kufai_output
//    CURRENCY=Ksh
//    HEADLESS=false                    # true for server / CI runs
//    MAX_SCROLL_ATTEMPTS=50
//    SCROLL_PAUSE_MS=2000
//    PLAY_WAIT_MS=3000
//    BATCH_SIZE=10
//    BATCH_SLEEP_MS=300
//    LOAD_EARLIER_RETRIES=5
//    NO_CHANGE_THRESHOLD=5
//
// ─────────────────────────────────────────────────────────────────────────────

const PORT                 = parseInt(process.env.PORT                 || '3000',  10);
const RAW_NUMBER           = (process.env.TARGET_NUMBER                || '2547504108').replace('@c.us', '');
const TARGET_NUMBER        = `${RAW_NUMBER}@c.us`;
const CONTACT_NAME         = process.env.CONTACT_NAME                  || 'Kungu Meru WhatsApp';
const FETCH_TARGET         = parseInt(process.env.FETCH_TARGET         || '120',   10);
const CURRENCY             = process.env.CURRENCY                      || 'Ksh';
const HEADLESS             = process.env.HEADLESS                      === 'true';
const MAX_SCROLL_ATTEMPTS  = parseInt(process.env.MAX_SCROLL_ATTEMPTS  || '50',    10);
const SCROLL_PAUSE_MS      = parseInt(process.env.SCROLL_PAUSE_MS      || '2000',  10);
const PLAY_WAIT_MS         = parseInt(process.env.PLAY_WAIT_MS         || '3000',  10);
const BATCH_SIZE           = parseInt(process.env.BATCH_SIZE           || '10',    10);
const BATCH_SLEEP_MS       = parseInt(process.env.BATCH_SLEEP_MS       || '300',   10);
const LOAD_EARLIER_RETRIES = parseInt(process.env.LOAD_EARLIER_RETRIES || '5',     10);
const NO_CHANGE_THRESHOLD  = parseInt(process.env.NO_CHANGE_THRESHOLD  || '5',     10);

// ── Output paths ──────────────────────────────────────────────────────────────
const OUTPUT_DIR    = path.resolve(process.env.OUTPUT_DIR || path.join(__dirname, 'kufai_output'));
const IMAGES_DIR    = path.join(OUTPUT_DIR, 'images');
const JSON_OUT_FILE = path.join(OUTPUT_DIR, 'menu_items.json');
fs.mkdirSync(IMAGES_DIR, { recursive: true });

// ── WhatsApp client ───────────────────────────────────────────────────────────
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: HEADLESS,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

client.on('qr', (qr) => {
    console.log('\n Scan this QR code in WhatsApp:');
    QRCode.generate(qr, { small: true });
});

client.on('authenticated', () => console.log(' Authenticated!'));
client.on('auth_failure', () => console.error(' Auth failed — delete .wwebjs_auth and retry'));

client.on('ready', async () => {
    console.log(' Client ready. Starting extraction…\n');
    await extractMenuItems();
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Scroll-based message loading ──────────────────────────────────────────────
async function scrollToLoadMessages(page, targetCount) {
    console.log(' Starting scroll-based message loading...');

    await sleep(PLAY_WAIT_MS);

    let previousCount = 0;
    let noChangeCount = 0;
    let scrollAttempts = 0;

    while (scrollAttempts < MAX_SCROLL_ATTEMPTS) {
        const currentCount = await page.evaluate(() => {
            const messages = document.querySelectorAll('[data-testid="msg-container"], .message-in, .message-out, [data-testid="conversation-panel-messages"] [data-testid="msg-container"]');
            return messages.length;
        });

        console.log(`   Scroll attempt ${scrollAttempts + 1}: ${currentCount} messages`);

        if (currentCount >= targetCount) {
            console.log(` Reached target of ${targetCount} messages!`);
            return currentCount;
        }

        if (currentCount === previousCount) {
            noChangeCount++;
            if (noChangeCount >= NO_CHANGE_THRESHOLD) {
                console.log(`   No new messages loaded after ${noChangeCount} attempts. Stopping scroll.`);
                break;
            }
        } else {
            noChangeCount = 0;
        }

        previousCount = currentCount;

        await page.evaluate(() => {
            const scrollableSelectors = [
                '#main .copyable-area [data-tab="8"]',
                '#main .copyable-area > div[tabindex="0"]',
                '#main [data-tab="8"]',
                '#main .message-list',
                '#main div[role="application"] div[tabindex="-1"]',
                '.copyable-area [data-tab="8"]'
            ];

            let container = null;
            for (const selector of scrollableSelectors) {
                container = document.querySelector(selector);
                if (container) {
                    console.log(`Found scroll container: ${selector}`);
                    break;
                }
            }

            if (container) {
                container.scrollTop = 0;
                const innerContainer = container.querySelector('div[tabindex="-1"]');
                if (innerContainer) innerContainer.scrollTop = 0;
            } else {
                const main = document.querySelector('#main');
                if (main) {
                    const scrollable = main.querySelector('[style*="overflow"]') || main;
                    scrollable.scrollTop = 0;
                }
            }
        });

        scrollAttempts++;
        await sleep(SCROLL_PAUSE_MS);
    }

    const finalCount = await page.evaluate(() => {
        const messages = document.querySelectorAll('[data-testid="msg-container"], .message-in, .message-out');
        return messages.length;
    });

    console.log(` Final message count after scrolling: ${finalCount}`);
    return finalCount;
}

// ── Trigger WhatsApp Web's infinite scroll ────────────────────────────────────
async function triggerInfiniteScroll(page) {
    console.log(' Attempting to trigger infinite scroll...');

    await page.evaluate(() => {
        const scrollContainer = document.querySelector('#main .copyable-area [data-tab="8"], #main [data-tab="8"]');
        if (scrollContainer) {
            for (let i = 0; i < 10; i++) {
                scrollContainer.scrollTop = 0;
                setTimeout(() => {}, 100);
            }
        }
    });

    await sleep(PLAY_WAIT_MS);
}

// ── Core extraction ───────────────────────────────────────────────────────────
async function extractMenuItems() {
    try {
        // ── Step 1: Find the chat ─────────────────────────────────────────────
        let chat = null;
        try {
            chat = await client.getChatById(TARGET_NUMBER);
            console.log(` Found chat by number: "${chat.name}"`);
        } catch (_) {
            console.log('  Number lookup failed — searching by name…');
            const all = await client.getChats();
            chat = all.find(c =>
                c.name && c.name.toLowerCase().includes(CONTACT_NAME.toLowerCase())
            );
        }

        if (!chat) {
            console.error(` Chat not found for "${CONTACT_NAME}" / ${TARGET_NUMBER}`);
            process.exit(1);
        }

        const chatId = chat.id._serialized;
        console.log(` Chat: "${chat.name}"  ID: ${chatId}\n`);

        // ── Step 2: Open the chat in WhatsApp Web ─────────────────────────────
        const page = client.pupPage;

        await page.evaluate((chatId, chatName) => {
            let chatElement = document.querySelector(`[data-id="${chatId}"]`);

            if (!chatElement) {
                const chatItems = document.querySelectorAll('[data-testid="cell-frame-container"], [role="row"]');
                for (const item of chatItems) {
                    const title = item.querySelector('span[title]');
                    if (title && title.getAttribute('title')?.toLowerCase().includes(chatName.toLowerCase())) {
                        chatElement = item;
                        break;
                    }
                }
            }

            if (chatElement) { chatElement.click(); return true; }
            return false;
        }, chatId, CONTACT_NAME);

        await sleep(PLAY_WAIT_MS);

        // ── Step 3: Load messages via scrolling ───────────────────────────────
        console.log(` Attempting to load ${FETCH_TARGET} messages...\n`);

        let loadedCount = await scrollToLoadMessages(page, FETCH_TARGET);

        if (loadedCount < FETCH_TARGET) {
            console.log(`\n Only loaded ${loadedCount} messages. Trying infinite scroll...\n`);
            await triggerInfiniteScroll(page);
            await sleep(SCROLL_PAUSE_MS);
            loadedCount = await scrollToLoadMessages(page, FETCH_TARGET);
        }

        await sleep(PLAY_WAIT_MS);

        // ── Step 4: Fetch messages from store ─────────────────────────────────
        console.log('\n Fetching messages from store...');

        let allFetched = [];

        try {
            allFetched = await chat.fetchMessages({ limit: FETCH_TARGET });
            console.log(` Got ${allFetched.length} messages from fetchMessages`);
        } catch (error) {
            console.log(` fetchMessages failed: ${error.message}`);
        }

        if (allFetched.length < 10) {
            console.log('Trying to load more messages using chat.loadEarlierMessages...');
            try {
                if (typeof chat.loadEarlierMessages === 'function') {
                    for (let i = 0; i < LOAD_EARLIER_RETRIES; i++) {
                        await chat.loadEarlierMessages();
                        await sleep(1000);
                    }
                    allFetched = await chat.fetchMessages({ limit: FETCH_TARGET });
                    console.log(` After loadEarlierMessages: ${allFetched.length} messages`);
                }
            } catch (error) {
                console.log(` loadEarlierMessages failed: ${error.message}`);
            }
        }

        // ── Step 5: Filter images ─────────────────────────────────────────────
        const imageMessages = allFetched.filter(m =>
            m.type === 'image' || (m.hasMedia && m.type === 'image')
        );
        console.log(`\n  Image messages found: ${imageMessages.length}\n`);

        if (imageMessages.length === 0) {
            console.log(' No image messages found.');
            process.exit(0);
        }

        // ── Step 6: Download + parse ───────────────────────────────────────────
        const menuItems = [];
        let processed = 0;
        let skipped = 0;

        for (const msg of imageMessages) {
            try {
                process.stdout.write(
                    `\r ${processed + skipped + 1}/${imageMessages.length}   ${processed}  ⏭ ${skipped}`
                );

                const media = await msg.downloadMedia();
                if (!media?.data) { skipped++; continue; }

                const ext = (media.mimetype.split('/')[1] || 'jpg').split(';')[0];
                const filename = `item_${processed}_${Date.now()}.${ext}`;
                const filepath = path.join(IMAGES_DIR, filename);
                fs.writeFileSync(filepath, Buffer.from(media.data, 'base64'));

                const caption = (msg.body || '').trim();
                let itemName = 'Unnamed Item';
                let itemPrice = '';

                if (caption) {
                    const atIdx = caption.indexOf('@');
                    if (atIdx !== -1) {
                        itemName = caption.slice(0, atIdx).trim() || 'Unnamed Item';
                        itemPrice = caption.slice(atIdx + 1).trim();
                    } else {
                        itemName = caption;
                    }
                }

                menuItems.push({
                    name: itemName,
                    category: 'General',
                    price: itemPrice ? `${CURRENCY} ${itemPrice}` : '',
                    imageUrl: `data:${media.mimetype};base64,${media.data}`,
                    imagePath: path.relative(OUTPUT_DIR, filepath),
                });

                processed++;
                if (processed % BATCH_SIZE === 0) await sleep(BATCH_SLEEP_MS);

            } catch (err) {
                skipped++;
                console.error(`\n  Skipped: ${err.message}`);
            }
        }

        // ── Step 7: Save ──────────────────────────────────────────────────────
        console.log(`\n\n Done — Processed: ${processed}  |  Skipped: ${skipped}`);

        fs.writeFileSync(JSON_OUT_FILE, JSON.stringify({ items: menuItems }, null, 2));
        const light = menuItems.map(({ imageUrl, ...rest }) => rest);
        fs.writeFileSync(
            path.join(OUTPUT_DIR, 'menu_items_paths.json'),
            JSON.stringify({ items: light }, null, 2)
        );

        console.log(`\n ${OUTPUT_DIR}`);
        console.log(`   • menu_items.json        ← import into Kufai's Menu Builder`);
        console.log(`   • menu_items_paths.json  ← paths-only reference`);
        console.log(`   • images/                ← ${processed} files`);
        console.log('\n Done! Import menu_items.json into the menu builder.');

        await client.destroy();
        process.exit(0);

    } catch (err) {
        console.error('\n Fatal error:', err.message);
        console.error(err.stack);
        process.exit(1);
    }
}

// ── Express status server ─────────────────────────────────────────────────────
app.use(express.static(OUTPUT_DIR));
app.get('/status', (_req, res) => {
    if (fs.existsSync(JSON_OUT_FILE)) {
        const data = JSON.parse(fs.readFileSync(JSON_OUT_FILE, 'utf8'));
        res.json({ status: 'ready', itemCount: data.items?.length || 0 });
    } else {
        res.json({ status: 'pending', itemCount: 0 });
    }
});
app.listen(PORT, () => {
    console.log(` Server: http://localhost:${PORT}  (GET /status)\n`);
});

client.initialize();
