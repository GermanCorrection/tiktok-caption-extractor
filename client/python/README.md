# tiktok-subtitles-client ⚡

Unofficial, zero-dependency Python client and CLI to extract subtitles, transcripts, and captions from any TikTok video.

Powered by Cloudflare Serverless Edge Workers — avoids heavy browser sessions and answers requests in milliseconds.

---

## 📦 Installation

```bash
# Direct install from git:
pip install git+https://github.com/vitobuchholz/tiktok-caption-extractor.git#subdirectory=client/python

# Or install locally in development mode:
cd client/python
pip install -e .
```

---

## 🐍 Python Usage

```python
from tiktok_subtitles import TikTokSubtitles

client = TikTokSubtitles()

# 1. Get full JSON (subtitles array, timestamps, metadata, download URLs)
data = client.get_subtitles("https://vm.tiktok.com/ZGeXXXXX/", format="json")
print("Detected Language:", data["language"])
print("Transcript Preview:", data["transcript"][:200])

# 2. Get clean transcript as plain text directly
text = client.get_transcript("https://vm.tiktok.com/ZGeXXXXX/")
print(text)

# 3. Download .SRT subtitle file for Premiere / CapCut / Final Cut Pro
client.download_srt("https://vm.tiktok.com/ZGeXXXXX/", output_path="subtitles.srt")

# 4. Download .VTT for HTML5 players
client.download_vtt("https://vm.tiktok.com/ZGeXXXXX/", output_path="subtitles.vtt")
```

---

## 💻 CLI Usage

```bash
# Print JSON output to terminal
tiktok-subtitles "https://vm.tiktok.com/ZGeXXXXX/"

# Save subtitles directly to an .srt file
tiktok-subtitles "https://vm.tiktok.com/ZGeXXXXX/" --format srt -o captions.srt

# Extract clean plain-text transcript
tiktok-subtitles "https://vm.tiktok.com/ZGeXXXXX/" --format txt -o speech.txt
```

---

## 🌐 Direct REST API (No Python Required)

```bash
# cURL
curl "https://captionfast.vitobuchholzx.workers.dev/api/v1/subtitles?url=https://vm.tiktok.com/ZGeXXXXX/&format=json"
```

Rate limit: 30 requests per minute per IP. No API key or registration required.
