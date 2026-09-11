# CaptionFast ⚡ – Instant TikTok Subtitle & Transcript Extractor

[![Live Web App](https://img.shields.io/badge/Live_Web_App-captionfast.github.io-00f2ea?style=for-the-badge&logo=github&logoColor=white)](https://captionfast.github.io/)
[![REST API](https://img.shields.io/badge/REST_API-Edge_Native-7928ca?style=for-the-badge)](https://captionfast.vitobuchholzx.workers.dev/api/v1/subtitles)
[![GitHub License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)](./LICENSE)
[![Tests](https://img.shields.io/badge/Tests-39_Passed-10b981?style=for-the-badge)](./tests)

> **🚀 Live Web App:** [https://captionfast.github.io](https://captionfast.github.io) *(Edge Worker: [https://captionfast.vitobuchholzx.workers.dev](https://captionfast.vitobuchholzx.workers.dev))*  
> **⚡ Public REST API:** [https://captionfast.vitobuchholzx.workers.dev/api/v1/subtitles?url={TIKTOK_URL}&format=json](https://captionfast.vitobuchholzx.workers.dev/api/v1/subtitles?url=https://vm.tiktok.com/ZGeXXXXX/&format=json)

A blazing-fast, 100% serverless web application, edge REST API, and Python CLI running on the Cloudflare global network. Automatically extracts closed captions, spoken transcripts, and subtitles from any TikTok link (including shortlinks like `vm.tiktok.com` or `vt.tiktok.com`) and exports them into `.srt`, `.vtt`, and clean `.txt` files in milliseconds without requiring sign-up or software installation.

---

## 🏗️ Stack & Architektur

- **Laufzeitumgebung & API**: [Cloudflare Workers](https://workers.cloudflare.com/) mit [Hono](https://hono.dev/) & TypeScript
- **Headless Scraping**: [Cloudflare Browser Rendering API](https://developers.cloudflare.com/browser-rendering/) (`@cloudflare/puppeteer`) für JavaScript-Hydration, Signatur-Handling und Captcha-Erkennung
- **Datenbank**: [Cloudflare D1](https://developers.cloudflare.com/d1/) für strukturierte Auftrags-Metadaten (Video-ID, Status, Zeitstempel, Segmentanzahl)
- **Objektspeicher**: [Cloudflare R2](https://developers.cloudflare.com/r2/) zur Speicherung der generierten `.srt`- und `.vtt`-Dateien
- **Warteschlange**: [Cloudflare Queues](https://developers.cloudflare.com/queues/) mit nativer Dead-Letter-Queue (`DLQ`), Backoff-Retries und Concurrency-Limit (Schutz der Browser Rendering Session-Pools)
- **Cache & Rate Limiting**: [Cloudflare KV](https://developers.cloudflare.com/kv/) für Idempotenz (bereits gescrapte Videos werden sofort zurückgegeben) und IP-basiertes Rate-Limiting (`CF-Connecting-IP`)
- **Frontend**: Modernes, responsives Glassmorphism-UI mit Status-Polling, Autorisierungs-Hinweis und One-Click-Downloads.

---

## 📁 Projektstruktur

```
tiktok-caption-extractor/
├── src/
│   ├── index.ts               # Worker-Haupteinstiegspunkt (Hono API + Queue Consumer)
│   ├── types.ts               # TypeScript Interfaces, Bindings & JobStatus
│   ├── db/
│   │   ├── schema.sql         # D1 SQL Schema
│   │   └── queries.ts         # Typsichere D1-Query-Funktionen
│   ├── services/
│   │   ├── resolver.ts        # Auflösung von Kurzlinks & Redirects (vm.tiktok.com)
│   │   ├── scraper.ts         # Cloudflare Browser Rendering + defensive JSON-Extraktion
│   │   ├── converter.ts       # Parser für TikTok JSON / WebVTT -> SRT & VTT Konverter
│   │   └── ratelimit.ts       # KV-basiertes Rate Limiting über CF-Connecting-IP
│   └── public/                # Web-Frontend (Static Assets)
│       ├── index.html         # Benutzeroberfläche mit Hinweis-Disclaimer
│       ├── style.css          # Modernes Dark-Mode Glassmorphism Design
│       └── app.js             # Client-Status-Polling und Download-Steuerung
├── tests/
│   ├── converter.test.ts      # Unit-Tests für SRT/VTT Konvertierung & JSON-Formate
│   └── resolver.test.ts       # Unit-Tests für Regex- und Hydration-Extraktion
├── wrangler.toml              # Cloudflare Konfiguration & Bindings
├── package.json
└── tsconfig.json
```

---

## 🚀 Schritt-für-Schritt Einrichtung & Deployment

### 1. Voraussetzungen
- [Node.js](https://nodejs.org/) (Version 18+)
- [Cloudflare Account](https://dash.cloudflare.com/)
- Cloudflare Workers Paid Plan (wird für die Cloudflare Browser Rendering API benötigt)

### 2. Abhängigkeiten installieren
```bash
cd tiktok-caption-extractor
npm install
```

### 3. Cloudflare-Ressourcen anlegen

#### a) Cloudflare D1 Datenbank
```bash
npx wrangler d1 create tiktok-db
```
*Kopiere die ausgegebene `database_id` und trage sie in `wrangler.toml` unter `[[d1_databases]]` ein.*

Initialisiere das Datenbankschema:
```bash
# Für lokale Entwicklung:
npm run d1:init

# Für Cloudflare Produktion:
npm run d1:init:remote
```

#### b) Cloudflare R2 Bucket
```bash
npx wrangler r2 bucket create tiktok-subtitles
```

> **Tipp (Lifecycle-Regel zum automatischen Aufräumen):**
> Richten Sie im Cloudflare Dashboard unter **R2** > **tiktok-subtitles** > **Settings** > **Lifecycle Rules** eine Regel ein, um Objekte nach 30 Tagen automatisch zu löschen (`Delete objects after 30 days`), um Speicherplatz zu sparen.

#### c) Cloudflare KV Namespace
```bash
npx wrangler kv:namespace create KV_CACHE
```
*Kopiere die ausgegebene `id` in `wrangler.toml` unter `[[kv_namespaces]]`.*

#### d) Cloudflare Queues anlegen
Erstelle die Haupt-Queue sowie die Dead-Letter-Queue:
```bash
npx wrangler queues create tiktok-caption-jobs
npx wrangler queues create tiktok-caption-jobs-dlq
```

---

## ⚙️ Wichtige Konfigurationsdetails (`wrangler.toml`)

- **Browser-Concurrency-Limit**:
  In `wrangler.toml` ist für den Queue-Consumer `max_batch_size = 1` und `max_concurrency = 2` festgelegt. Dies stellt sicher, dass nicht zu viele parallele Chromium-Browserinstanzen gestartet werden, wodurch das Account-Limit von Cloudflare Browser Rendering geschützt wird.
- **In-Page Subtitle Download**:
  Der Download der Untertitel-Streams wird direkt im Puppeteer-Seitenkontext (`page.evaluate(fetch)`) ausgeführt, damit TikTok-Referer und Session-Header erhalten bleiben und das TikTok-CDN die Anfrage nicht mit HTTP 403 abweist.
- **Fail-Fast vs. Native Queue Retries**:
  Endgültige Fehler (`no_subtitles_available`, `video_private_or_deleted`, `failed_blocked`) werden sofort quittiert (`message.ack()`), um unnötige Browser-Ressourcen zu sparen. Nur bei transienten Fehlern greift der Queue-Retry mit exponentiellem Backoff.

---

## 💻 Lokale Entwicklung & Tests

```bash
# Unit-Tests ausführen
npm test

# Lokalen Entwicklungsserver starten
npm run dev
```

---

## 🌐 Bereitstellung (Deploy)

```bash
npx wrangler deploy
```

Nach dem Deployment ist die Anwendung unter Ihrer Workers-Domain (z. B. `https://tiktok-caption-extractor.<subdomain>.workers.dev`) erreichbar.

---

## 📡 API-Dokumentation

### `POST /api/submit`
Reicht einen TikTok-Link ein. Löst Weiterleitungen auf und prüft vorab den Cache (Idempotenz).

**Request Body:**
```json
{
  "url": "https://vm.tiktok.com/ZGeXXXXXX/"
}
```

**Response (Neu eingereiht):**
```json
{
  "success": true,
  "jobId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "videoId": "7391234567890123456",
  "status": "queued",
  "cached": false
}
```

**Response (Bereits vorhanden / Cache-Hit):**
```json
{
  "success": true,
  "jobId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "videoId": "7391234567890123456",
  "status": "done",
  "language": "de",
  "cached": true
}
```

---

### `GET /api/status/:jobId`
Liefert den aktuellen Verarbeitungsstatus des Auftrags.

**Mögliche Status-Werte:**
- `queued`: In der Queue, wartet auf freien Browser-Slot
- `processing`: Browser geöffnet, rendert Seite und extrahiert Untertitel
- `done`: Erfolgreich extrahiert und in R2 gespeichert
- `no_subtitles_available`: Video besitzt keine Untertitel/Captions
- `video_private_or_deleted`: Video nicht öffentlich zugänglich
- `failed_blocked`: Sicherheitsüberprüfung (Captcha) durch TikTok
- `invalid_link`: Link konnte nicht aufgelöst werden
- `error`: Unerwarteter technischer Fehler

**Response (Fertig):**
```json
{
  "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "videoId": "7391234567890123456",
  "status": "done",
  "language": "de",
  "captionCount": 42,
  "downloads": {
    "srt": "/api/download/3fa85f64-5717-4562-b3fc-2c963f66afa6/srt",
    "vtt": "/api/download/3fa85f64-5717-4562-b3fc-2c963f66afa6/vtt"
  }
}
```

---

### `GET /api/download/:jobId/:format`
Liefert die generierte Untertitel-Datei (`format`: `srt` oder `vtt`) als direkten Download-Stream mit `Content-Disposition: attachment`.

---

## ⚡ Öffentliche Developer REST-API (`/api/v1/subtitles`)

Öffentlicher REST-Endpunkt für Entwickler und Bots (kein API-Key erforderlich, Rate-Limit: 30 Requests pro IP pro Minute).

Nutzt ausschließlich Tier 1 (Universal Data Rehydration) und Tier 2 (Alternative Mirror API) und liefert Ergebnisse in wenigen Millisekunden ohne Browser-Warteschlange.

### Endpunkt
`GET /api/v1/subtitles?url={TIKTOK_URL}&format={FORMAT}`

### Parameter
- `url` (*Pflicht*): Vollständige oder gekürzte TikTok-URL (`https://vm.tiktok.com/...` oder `https://www.tiktok.com/@user/video/...`)
- `format` (*Optional*): `'json'` (Standard), `'srt'`, `'vtt'`, oder `'txt'`

### Beispiel cURL
```bash
# 1. JSON mit Transkript & Metadaten abrufen
curl "https://captionfast.vitobuchholzx.workers.dev/api/v1/subtitles?url=https://vm.tiktok.com/ZGeXXXXX/&format=json"

# 2. Direkt als .SRT Datei herunterladen
curl -o video.srt "https://captionfast.vitobuchholzx.workers.dev/api/v1/subtitles?url=https://vm.tiktok.com/ZGeXXXXX/&format=srt"
```

### JSON-Antwort (`format=json`):
```json
{
  "videoId": "7391234567890123456",
  "language": "de",
  "captionCount": 35,
  "transcript": "Hier ist das vollständige Transkript des Videos...",
  "subtitles": [
    { "text": "Hier ist das vollständige", "start": 0, "end": 1500 },
    { "text": "Transkript des Videos...", "start": 1500, "end": 3200 }
  ],
  "downloads": {
    "srt": "https://captionfast.vitobuchholzx.workers.dev/api/download/xxx/srt",
    "vtt": "https://captionfast.vitobuchholzx.workers.dev/api/download/xxx/vtt"
  }
}
```

---

## 🐍 Python Client (`tiktok-subtitles-client`)

Ein leichtgewichtiger Python-Client ohne externe Abhängigkeiten liegt im Verzeichnis `client/python`:

### Installation
```bash
pip install git+https://github.com/vitobuchholz/tiktok-caption-extractor.git#subdirectory=client/python
```

### Verwendung in Python
```python
from tiktok_subtitles import TikTokSubtitles

client = TikTokSubtitles()

# Transkript direkt als String abrufen
transcript = client.get_transcript("https://vm.tiktok.com/ZGeXXXXX/")
print(transcript)

# .SRT Datei direkt für Videoschnitt speichern
client.download_srt("https://vm.tiktok.com/ZGeXXXXX/", "subtitles.srt")
```

### CLI
```bash
python client/python/tiktok_subtitles.py "https://vm.tiktok.com/ZGeXXXXX/" --format srt -o video.srt
```

---

## ⚖️ Rechtlicher Hinweis
Die Nutzung dieser Anwendung ist ausschließlich für eigene Inhalte oder mit ausdrücklicher Genehmigung der jeweiligen Rechteinhaber bestimmt. Die Nutzungsbedingungen und Richtlinien der Plattform TikTok sind stets einzuhalten.
