# Shopee restock tracker

Watches Shopee listings and alerts you when one flips from **not purchasable** to
**purchasable**. No login, no cookies, no API key.

Currently watching three PREMIUM BANDAI pre-orders, all from shop `435791627`:

| Item | Product id | Delivery |
|---|---|---|
| One Piece Premium Card Collection -ONE PIECE DAY'26- | `55366324866` | Dec 2026 |
| One Piece Card Game 4th Anniversary Set | `54965355390` | Mar 2027 |
| Gundam Card Game 1st Anniversary Set | `57314039530` | Feb 2027 |

## How it detects stock

Shopee's PDP API (`/api/v4/pdp/get_pc`) rejects logged-out callers with error
`90309999`. But the server-rendered product HTML still embeds the whole PDP
payload, and that is readable anonymously. The tracker pulls that blob out and
inspects the variation list.

What matters is reading the right field:

| Field | Logged out | Usable? |
|---|---|---|
| `stock` | masked — **every** variation reports `10`, sold out or not | No |
| `price`, `historical_sold` | nulled out | No |
| `is_grayout` / `is_clickable` | truthful, per variation | **Yes** |

Verified against a multi-variation control listing: only the genuinely available
options came back `is_grayout: false` / `is_clickable: true`, while sold-out ones
came back `is_grayout: true` — even though all of them claimed `stock: 10`.

So **available = at least one variation with `is_grayout: false`**, and only when
the listing itself is live (`item_status: "normal"`, `status: 1`) so a delisted
item is never misread as available.

## Commands

Check once and alert on a restock (this is what the scheduled task runs):

```bash
node C:\Users\leowh\shopee-stock-tracker\tracker.js
```

Print current state without alerting:

```bash
node C:\Users\leowh\shopee-stock-tracker\tracker.js --status
```

Stay in the foreground, re-checking every 15 minutes:

```bash
node C:\Users\leowh\shopee-stock-tracker\tracker.js --watch 15
```

Fire a test notification:

```bash
node C:\Users\leowh\shopee-stock-tracker\tracker.js --test-alert
```

See exactly what a restock alert will look like, using the real product title
and URL, without waiting for a restock or touching saved state:

```bash
node C:\Users\leowh\shopee-stock-tracker\tracker.js --preview-alert
```

Preview a specific item by its `id` from `items.json`:

```bash
node C:\Users\leowh\shopee-stock-tracker\tracker.js --preview-alert gundam-1st-anniversary-set
```

Clear saved state so the next run re-baselines:

```bash
node C:\Users\leowh\shopee-stock-tracker\tracker.js --reset
```

## Run it on a schedule

Register a Windows scheduled task that checks every 15 minutes:

```bash
schtasks /Create /TN "Shopee restock tracker" /SC MINUTE /MO 15 /TR "node.exe \"C:\Users\leowh\shopee-stock-tracker\tracker.js\"" /F
```

Remove it later:

```bash
schtasks /Delete /TN "Shopee restock tracker" /F
```

Keep the interval at 10 minutes or more. This scrapes a public page; hammering it
is rude and is the fastest way to get rate-limited.

## Adding more items

Edit `items.json`. `shopId` and `itemId` are the two numbers in a Shopee product
URL — `shopee.com.my/product/<shopId>/<itemId>`. For the
`...-i.<shopId>.<itemId>` URL form, the same two numbers sit at the end.

```json
{
  "webhookUrl": null,
  "items": [
    {
      "id": "some-stable-key",
      "label": "Human readable name",
      "shopId": "435791627",
      "itemId": "55366324866",
      "openBrowserOnRestock": true
    }
  ]
}
```

- `openBrowserOnRestock` — opens the listing in your default browser the moment
  it goes available. Useful for anything that sells out fast.
- `webhookUrl` — optional. See "Phone alerts" below. Off by default; nothing
  leaves your machine unless you fill this in.
- `webhookMention` — optional, top level. A Discord mention such as `"@here"` or
  `"<@your-user-id>"`. Mentions are what actually trigger a push notification on
  a phone, so set this if you want the alert to buzz rather than sit quietly.

## Phone alerts (Discord)

1. In Discord, pick a server you own (or make one — "+" in the sidebar, it's free
   and can be private with just you in it).
2. Right-click the channel you want alerts in → **Edit Channel** → **Integrations**
   → **Webhooks** → **New Webhook**.
3. **Copy Webhook URL**. It looks like
   `https://discord.com/api/webhooks/<id>/<token>`.
4. Paste it into `items.json` as `webhookUrl`.
5. Install Discord on your phone and enable notifications for that channel.

Then confirm delivery without waiting for a restock:

```bash
node C:\Users\leowh\shopee-stock-tracker\tracker.js --test-webhook
```

Treat that URL as a secret: anyone holding it can post messages into your
channel. It grants nothing else — it cannot read messages or touch your account
— and you can revoke it anytime by deleting the webhook in the same screen.

Discord alerts arrive as an embed with the product title as a tappable link.
Slack incoming-webhook URLs work too; the payload shape adapts automatically.

## Testing

```bash
node C:\Users\leowh\shopee-stock-tracker\test-tracker.js
```

30 offline assertions against saved real pages in `fixtures/` — no network, no
notifications, no state files touched. Covers both real listings (one sold out,
one in stock), plus guards: a delisted listing must never read as available,
`stock: 10` on a grayed-out variation must never read as available, brace
matching must survive braces and quotes inside product titles, and malformed
payloads must return null rather than throw.

Run this after editing `tracker.js`, and whenever `restock.log` starts showing
`product payload not found` — that means Shopee changed their page structure and
the fixtures need refreshing alongside the parser.

## Files

- `tracker.js` — the tracker
- `test-tracker.js` — offline test suite
- `fixtures/` — saved product pages the tests run against
- `items.json` — your watch list
- `state.json` — last known state per item (generated; drives restock detection)
- `restock.log` — append-only history of every check (generated)

## Notes and limits

- Alerts fire on the *transition* into availability, so a scheduled run won't
  re-notify every 15 minutes while the item stays in stock.
- A failed fetch (network blip, login-wall shell) is logged as a failure and
  explicitly does **not** overwrite the last known state, so it can't cause a
  false alert or silently clear one.
- If Shopee changes its page structure the payload lookup will start failing.
  That shows up in `restock.log` as `product payload not found` — a signal to
  re-check the parsing, not evidence the item is unavailable.
- This is a pre-order listing. "Available" here means the buy button becomes
  active, which for a pre-order is the order window opening.
