# LabelCast

**Print from Odoo Mobile to any Zebra printer. Instantly.**

LabelCast is a lightweight local print agent that runs on a Windows PC, receives PDF print jobs from Odoo (or any HTTP client), converts them to ZPL, and delivers them to your Zebra label printer over TCP port 9100 — in under two seconds.

No cloud. No subscription. No data leaves your network.

🌐 **[labelcast.net](https://labelcast.net)**

---

## The problem it solves

Odoo's mobile app only generates PDFs. Zebra printers speak ZPL. There is nothing in between that is simple, self-hosted, and free.

The existing options all have the same problems:
- **PrintNode** — routes your jobs through external servers, charges $9–$990/yr, requires internet
- **QZ Tray** — pops up a dialogue every single print unless you pay for the premium certificate
- **Odoo IoT Box** — adds hardware cost and complexity, still doesn't solve mobile cleanly

LabelCast runs on a PC you already own, on your existing network, with no ongoing fees.

---

## How it works

```
Odoo Mobile → HTTP POST (PDF) → LabelCast Agent → PDF→ZPL → Zebra Printer (TCP:9100)
```

1. Odoo mobile renders a label report as PDF and POSTs it to the agent
2. The agent converts the PDF to ZPL using Ghostscript
3. ZPL is sent directly to the Zebra printer's TCP socket on port 9100
4. Label prints in under 2 seconds

---

## Quick start

### Prerequisites

| Tool | Purpose | Download |
|---|---|---|
| Node.js 18+ | Runs the agent | https://nodejs.org |
| Ghostscript 64-bit | PDF → ZPL conversion | https://www.ghostscript.com/releases/gsdnld.html |

> **Ghostscript tip:** During install tick **"Add to PATH"** so the agent finds it automatically.

### Install

```bash
# 1. Clone the repo
git clone https://github.com/labelCast/labelcast-agent.git
cd labelcast-agent

# 2. Copy the config file
copy .env.example .env

# 3. Edit .env — set your printer IP and API token
notepad .env

# 4. Start the agent
start.bat
```

Or just double-click **start.bat** — it handles everything on first run.

### Configure `.env`

```ini
PRINTER_HOST=192.168.1.100   # Your Zebra printer's IP address
PRINTER_PORT=9100            # Almost always 9100
API_TOKEN=your-secret-token  # Any strong random string
LABEL_DPI=203                # 203 or 300 depending on your Zebra model
AGENT_PORT=7777              # Port the HTTP server listens on
```

> **Find your Zebra's IP:** Hold the Feed button for 2 seconds to print a config label. The IP address is on it.

---

## API

### `GET /health` — no auth required
```json
{
  "status": "ok",
  "printer": { "ok": true, "message": "Printer reachable" }
}
```

### `POST /print` — send a print job

**Auth:** `X-Print-Token: your-secret-token` header required

**Option A — JSON + base64 (recommended for Odoo)**
```json
{
  "pdf": "<base64-encoded PDF>",
  "copies": 1,
  "label": "shipping-label"
}
```

**Option B — Multipart file upload**
```
pdf=<file>, copies=1, label=delivery
```

**Option C — Raw PDF body**
```
Content-Type: application/pdf
```

**Response**
```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "queued",
  "message": "Job queued successfully"
}
```

### `GET /jobs/:id` — check job status
```json
{
  "id": "550e...",
  "status": "done",
  "labelName": "shipping",
  "copies": 1
}
```

Status values: `queued` → `processing` → `done` | `failed`

### `GET /jobs` — list last 50 jobs

### `GET /printer/status` — ping the Zebra printer

---

## Odoo integration

Import the included `odoo/labelcast_server_actions.xml` file into Odoo:

1. Enable Developer Mode: **Settings → General Settings → Developer Tools → Activate**
2. Go to **Settings → Technical → Server Actions**
3. Import `labelcast_server_actions.xml`
4. Set your config in **Settings → Technical → System Parameters**:

| Parameter | Value |
|---|---|
| `labelcast.agent.url` | `http://192.168.1.50:7777` |
| `labelcast.api.token` | your secret token |
| `labelcast.copies` | `1` |

The **Print Label (LabelCast)** option now appears in the Action menu on:
- Inventory → Transfers
- Inventory → Products
- Inventory → Lots/Serial Numbers

---

## Running as a Windows Service

So the agent starts automatically when Windows boots:

**Option 1 — NSSM (recommended)**
```bat
:: Download nssm from https://nssm.cc
nssm install LabelCast "C:\Program Files\nodejs\node.exe" "C:\labelcast-agent\src\server.js"
nssm set LabelCast AppDirectory "C:\labelcast-agent"
nssm start LabelCast
```

**Option 2 — node-windows**
```bat
npm install -g node-windows
npm link node-windows
node scripts/install-service.js
```

---

## Open firewall port

Run once in an admin Command Prompt:
```bat
netsh advfirewall firewall add rule name="LabelCast" dir=in action=allow protocol=TCP localport=7777
```

---

## Project structure

```
labelcast-agent/
├── src/
│   ├── server.js      ← HTTP server + routes
│   ├── queue.js       ← In-memory print queue
│   ├── converter.js   ← PDF → ZPL (Ghostscript)
│   ├── printer.js     ← TCP socket → Zebra port 9100
│   └── logger.js      ← Winston logger
├── odoo/
│   └── labelcast_server_actions.xml  ← Odoo import file
├── scripts/
│   └── install-service.js
├── logs/
├── .env.example
├── package.json
├── start.bat
└── README.md
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Ghostscript not found` | Install GS and tick "Add to PATH", or set `GS_PATH` in `.env` |
| `Connection timed out` | Check `PRINTER_HOST` IP, confirm port 9100 is open |
| `401 Unauthorized` | Add `X-Print-Token` header in Odoo system parameters |
| Label prints garbled | Check `LABEL_DPI` matches your printer's physical DPI |
| Agent not reachable from phone | Open Windows Firewall port 7777 (command above) |
| Health check shows printer offline | Printer is off, wrong IP, or firewall blocking port 9100 |

---

## Image quality

For best barcode scan results:

- Install **jimp** for improved image processing: `npm install jimp`
- Use `LABEL_DPI=300` for high-resolution Zebra models
- For pure ZPL workflows set `CONVERSION_STRATEGY=direct` in `.env`

---

## Pricing

| Tier | Price | What you get |
|---|---|---|
| Community | Free | This repo — full source, MIT licence |
| Single Site | $97 one-time | Windows installer, setup wizard, Odoo server action, 90-day support |
| Pro | $197 one-time | Multi-printer routing, priority support, 5 locations |
| Partner / VAR | $497 one-time | Reseller rights, unlimited clients, 30% referral commission |

👉 **[labelcast.net](https://labelcast.net)**

---

## Licence

MIT — free to use, modify, and distribute. See [LICENSE](LICENSE).

---

## Contributing

Issues and PRs welcome. If you've tested with a specific Zebra model or Odoo version not listed here, please open a PR to update the compatibility table.

---

Built by someone who couldn't get their warehouse labels to print from a phone. 🏷️
