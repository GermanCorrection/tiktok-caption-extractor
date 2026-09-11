"""
TikTok Subtitles Client
Unofficial, high-speed Python client to extract subtitles and transcripts from TikTok videos.
Powered by Cloudflare Serverless Edge API (Fast HTML Rehydration + Mirror Fallback).

Usage:
    from tiktok_subtitles import TikTokSubtitles

    client = TikTokSubtitles()
    data = client.get_transcript("https://vm.tiktok.com/ZGeXXXXXX/")
    print(data["transcript"])

CLI Usage:
    python tiktok_subtitles.py "https://vm.tiktok.com/ZGeXXXXXX/" --format srt -o video.srt
"""

import argparse
import json
import sys
import urllib.parse
import urllib.request
import urllib.error
from typing import Optional, Dict, Any, Union

DEFAULT_API_BASE = "https://captionfast.vitobuchholzx.workers.dev"


class TikTokSubtitlesError(Exception):
    """Raised when the TikTok subtitles API returns an error or fails."""
    pass


class TikTokSubtitles:
    """Python client for the TikTok Subtitle Extractor API."""

    def __init__(self, api_base: str = DEFAULT_API_BASE, timeout: int = 15):
        self.api_base = api_base.rstrip("/")
        self.timeout = timeout

    def get_subtitles(
        self,
        url: str,
        format: str = "json"
    ) -> Union[Dict[str, Any], str]:
        """
        Fetch subtitles or transcript for a TikTok video URL.

        :param url: Full or short TikTok URL (e.g. https://vm.tiktok.com/... or https://www.tiktok.com/@user/video/...)
        :param format: 'json', 'srt', 'vtt', or 'txt'
        :return: Dict if format='json', or str if format in ('srt', 'vtt', 'txt')
        """
        valid_formats = ("json", "srt", "vtt", "txt")
        if format not in valid_formats:
            raise ValueError(f"Invalid format '{format}'. Must be one of: {', '.join(valid_formats)}")

        query = urllib.parse.urlencode({"url": url, "format": format})
        endpoint = f"{self.api_base}/api/v1/subtitles?{query}"

        req = urllib.request.Request(
            endpoint,
            headers={
                "User-Agent": "TikTokSubtitlesPythonClient/1.0",
                "Accept": "application/json" if format == "json" else "text/plain",
            }
        )

        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                content = resp.read().decode("utf-8")
                if format == "json":
                    return json.loads(content)
                return content
        except urllib.error.HTTPError as err:
            body = err.read().decode("utf-8", errors="replace")
            try:
                err_data = json.loads(body)
                msg = err_data.get("details") or err_data.get("error") or body
            except Exception:
                msg = body
            raise TikTokSubtitlesError(f"HTTP {err.code}: {msg}") from err
        except urllib.error.URLError as err:
            raise TikTokSubtitlesError(f"Network error: {err.reason}") from err

    def get_transcript(self, url: str) -> str:
        """Helper to get clean plain-text transcript."""
        result = self.get_subtitles(url, format="txt")
        return str(result)

    def download_srt(self, url: str, output_path: str) -> str:
        """Download and save .srt file for video editing."""
        content = self.get_subtitles(url, format="srt")
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(str(content))
        return output_path

    def download_vtt(self, url: str, output_path: str) -> str:
        """Download and save .vtt file."""
        content = self.get_subtitles(url, format="vtt")
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(str(content))
        return output_path


def main():
    parser = argparse.ArgumentParser(
        description="Extract TikTok captions/subtitles via Edge API"
    )
    parser.add_argument("url", help="TikTok video link (e.g. https://vm.tiktok.com/... or https://tiktok.com/@user/video/...)")
    parser.add_argument(
        "--format", "-f",
        choices=["json", "srt", "vtt", "txt"],
        default="json",
        help="Desired output format (default: json)"
    )
    parser.add_argument(
        "--output", "-o",
        help="Save output to file instead of printing to stdout"
    )
    parser.add_argument(
        "--api-base",
        default=DEFAULT_API_BASE,
        help="Custom API base URL (default: official edge worker)"
    )

    args = parser.parse_args()
    client = TikTokSubtitles(api_base=args.api_base)

    try:
        res = client.get_subtitles(args.url, format=args.format)
        output_str = json.dumps(res, indent=2, ensure_ascii=False) if isinstance(res, dict) else res

        if args.output:
            with open(args.output, "w", encoding="utf-8") as f:
                f.write(output_str)
            print(f"Saved {args.format.upper()} output to {args.output}", file=sys.stderr)
        else:
            print(output_str)
    except TikTokSubtitlesError as err:
        print(f"Error: {err}", file=sys.stderr)
        sys.exit(1)
    except Exception as err:
        print(f"Unexpected error: {err}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
