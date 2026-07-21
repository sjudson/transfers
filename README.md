# ManGame Transfer Tracker

A Chromium extension that watches the ManGame transfer season for you: your free-agent bids, a shortlist you choose, and any deals your team is in. It shows who's leading, your minimum next bid, the 48-hour countdowns, your daily bid allowance, and your total committed
salary / transfer fees / loan fees **if you win everything you currently lead**.

It is **read-only** — it never posts, edits, or changes anything on the site.
It only reads pages while **you are logged in to the site in the same
browser**, and it reads them gently (see *How it stays gentle* below).

---

## Install (2 minutes, one time)

1. **Download** this folder to your computer (unzip it if it came as a `.zip`).
   Keep the `extension` folder somewhere you won't delete it.
2. Open your browser and go to **`chrome://extensions`**
   (on Edge: `edge://extensions`, on Brave: `brave://extensions`).
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the **`extension`** folder
   (the one containing `manifest.json`).
5. A listing for the ManGame Transfer Tracker will appear in your extensions tab: **Make sure you're logged into the site**, then click the icon to open the tracker.

To update later, replace the folder's files and click the ↻ button
on the extension's card in `chrome://extensions`.

---

## Using it

1. **Set your team name** in *Setup* (start typing — it autocompletes from the
   official 2026 database). The tool will use the database to prepopulate the
   team-related fields, but you can also add numbers manually for things like
   existing salary commitment, overall budget, and the amount you want to **reserve**
   for things like training and wildcard bids.
3. **Add free agents to your shortlist** — search by name and click *Add*.
   These are the riders it will track for you (whether or not you've bid yet).
4. **Deals**: any deal thread that mentions your team on the recent list shows
   up automatically. You can also paste a thread link to track one.
5. Watch the **Committed** and **Bids this window** cards, and the tables.

Everything is stored **locally on your machine** (nothing is uploaded).

### Reading the free-agents table

| Column | Meaning |
|---|---|
| Your bid | Highest bid you've placed in that thread |
| Leading | Current highest **valid** bid |
| Leader | **YOU** (green row) or the team that's ahead |
| Min next | The smallest legal bid you could place next |
| Status | Live / Closing (<6h) / Sold |
| Sold/last bid in | Countdown to the 48h no-bid deadline |

All times are shown in **BST** (the timezone the transfer rules use). The tool
auto-detects the forum's clock so this stays correct even if your forum profile
uses a different timezone.

---

## How it stays gentle on the server

After an (itself) rate-limited initialization step to slowly build the current state of the forum, the update cycle is fixed to a minimum of 30s. **Reloading the page only resets this timer and slows down the update.** 

---

## Troubleshooting

- **Red "not logged in" banner** → open the site, log in, come back and click
  *Refresh now*. The transfer forums are hidden from logged-out visitors.
- **A shortlisted rider shows "no thread found"** → nobody has started that
  rider's `[Free Agent]` thread yet, or it's deep in the forum. It'll appear once
  the thread exists / becomes active.
- **Testing against an old season** → *Setup → Advanced: forum IDs*, enter the
  archived forums' IDs.

---

## For developers

Plain ES-module JavaScript, **no build step** — the `extension/` folder *is* the
artifact. Manifest V3, Chromium-portable (no Chrome-proprietary APIs).

```
extension/
  manifest.json        MV3 manifest (host permission for pcmdaily.com only)
  service_worker.js    opens/focuses the dashboard tab
  dashboard.html/.css  the UI
  data/                bundled DB snapshot: riders.json, teams.json
  src/
    net.js             rate-limited + cached + conditional fetching
    parse.js           DOMParser: forum listings & thread posts
    tz.js              BST normalisation (self-calibrating from the forum clock)
    ridersdb.js        rider/team lookups from the bundled snapshot
    model.js           bid math, valid-bid reconstruction, 48h, commitments
    ui.js              rendering
    main.js            controller + refresh loop
    db.js              IndexedDB (config, HTTP cache, snapshots)
test/run.mjs           jsdom test harness (node test/run.mjs)
```

Regenerate the DB snapshot from a new `.xlsm` with the exporter in
`tools/` (see that folder). Run tests: `cd test && npm i && node run.mjs`.
