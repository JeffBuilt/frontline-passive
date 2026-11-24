# Frontline app (v3) + HQ dashboard

**Frontline app** (`index.html`, `app.js`, `sw.js`): offline phone app for finishing jobs.
Month → jobs (colour-coded by photos: red none, amber before only, green before + after) → take or upload before/after photos → Docs (SWMS, ATW) → make the service report.
Jobs come from the WO tab of the Projects register; photos and docs live in each job's Drive folder (Before Photos / After Photos / Docs).
Backend: `apps-script/Code.gs`, in the Apps Script project bound to the Passive Fire Master sheet. One shared PIN (sheet menu Frontline > Set app PIN).

**HQ dashboard** (`hq.html` + `hq/Code.gs`): one screen, revenue by company per month (3 months back, 12 ahead), live from the WO tab.

The previous v2.1.1 app and both v1/v2 backends are kept in `archive/v2/`.
No prices, PINs or keys live in this repo.
