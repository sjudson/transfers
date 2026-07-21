# ManGame Transfer Tracker

A Chrome/Chromium extension that watches the [pcmdaily.com](https://pcmdaily.com)
ManGame transfer season for you: your free-agent bids, a shortlist you choose,
and any deals your team is in. It shows who's leading, your minimum next bid,
the 48-hour countdowns, your daily bid allowance, and your total committed
salary / transfer fees / loan fees **if you win everything you currently lead**.

It is **read-only** — it never posts, edits, or changes anything on pcmdaily.
It only reads pages while **you are logged into pcmdaily.com in the same
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
5. A cycling-jersey icon appears in your toolbar. **Make sure you're logged into
   pcmdaily.com**, then click the icon to open the tracker.

That's it. To update later, replace the folder's files and click the ↻ button
on the extension's card in `chrome://extensions`.

---

## Using it

1. **Set your team name** in *Setup* (start typing — it autocompletes from the
   official database).
2. **Add free agents to your shortlist** — search by name and click *Add*.
   These are the riders it will track for you (whether or not you've bid yet).
3. **Deals**: any deal thread that mentions your team on the recent list shows
   up automatically. You can also paste a thread link to track one. Because deal
   structures vary, type the **transfer fee / loan fee / salary change** for each
   deal into the boxes — the tracker adds them into your totals. (It shows the €
   figures it spotted in the thread as hints.)
4. Watch the **Committed** and **Bids this window** cards, and the tables.

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

- It only runs **while the dashboard tab is open**.
- It polls each forum's **first page** on your chosen interval (default 30s) and
  **only re-reads a thread when its last-post time has actually changed**.
- Every page is cached locally with a minimum time-to-live, unchanged pages come
  back as tiny "304 Not Modified" replies, and there's a hard **4-second minimum
  gap** between any two requests plus a per-refresh fetch budget.
- The header shows how many upstream requests it has made this session.

---

## Troubleshooting

- **Red "not logged in" banner** → open pcmdaily.com, log in, come back and click
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
