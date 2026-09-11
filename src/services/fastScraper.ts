import { ScrapeResult } from '../types';
import { extractSubtitlesFromRehydrationData } from './scraper';
import { parseRawSubtitles } from './converter';

const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const FETCH_TIMEOUT_MS = 4000;

/**
 * TIER 1: Lightweight HTML Rehydration Scraping
 * Executes a fast Worker fetch() against TikTok and parses the embedded JSON script.
 * Uses AbortSignal.timeout(4000) to fail fast and hand off to Tier 2 if TikTok is sluggish.
 */
export async function scrapeFastSubtitles(
  resolvedUrl: string,
  videoId: string,
  customCookie?: string
): Promise<ScrapeResult> {
  try {
    const targetUrl =
      resolvedUrl && resolvedUrl.includes('/@')
        ? resolvedUrl
        : `https://www.tiktok.com/@i/video/${videoId}`;

    const headers: Record<string, string> = {
      'User-Agent': DESKTOP_USER_AGENT,
      'Accept':
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Cache-Control': 'max-age=0',
    };

    if (customCookie) {
      headers['Cookie'] = customCookie;
    }

    const response = await fetch(targetUrl, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (response.status === 403 || response.status === 429) {
      return {
        success: false,
        status: 'failed_blocked',
        error: `TikTok returned HTTP ${response.status} (Bot protection active)`,
      };
    }

    if (response.status === 404) {
      return {
        success: false,
        status: 'video_private_or_deleted',
        error: 'Video is private, removed, or not found (HTTP 404)',
      };
    }

    const html = await response.text();

    // Check for obvious block or captcha strings
    if (
      html.includes('verify-bar') ||
      html.includes('captcha_verify_container') ||
      html.includes('sec-sdk-captcha')
    ) {
      return {
        success: false,
        status: 'failed_blocked',
        error: 'TikTok security verification encountered in HTML',
      };
    }

    // Extract __UNIVERSAL_DATA_FOR_REHYDRATION__
    let hydrationMatch = html.match(
      /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/i
    );

    // Fallback: SIGI_STATE
    if (!hydrationMatch || !hydrationMatch[1]) {
      hydrationMatch = html.match(
        /<script id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/i
      );
    }

    if (!hydrationMatch || !hydrationMatch[1]) {
      return {
        success: false,
        status: 'error',
        error: 'No rehydration script found in HTML payload',
      };
    }

    let parsedData: any = null;
    try {
      parsedData = JSON.parse(hydrationMatch[1].trim());
    } catch {
      return {
        success: false,
        status: 'error',
        error: 'Failed to parse rehydration JSON script',
      };
    }

    // Use our recursive subtitle extractor
    const subtitleInfos = extractSubtitlesFromRehydrationData(parsedData, videoId);

    if (subtitleInfos.length === 0) {
      return {
        success: false,
        status: 'no_subtitles_available',
        error: 'No subtitle streams found in rehydration state',
      };
    }

    // Pick preferred subtitle
    const selectedSubtitle =
      subtitleInfos.find((s) => s.isOriginal) ||
      subtitleInfos.find((s) => s.languageCode.startsWith('de') || s.languageCode.startsWith('en')) ||
      subtitleInfos[0];

    // Download the subtitle file directly
    const captionRes = await fetch(selectedSubtitle.url, {
      headers: {
        'User-Agent': DESKTOP_USER_AGENT,
        'Referer': 'https://www.tiktok.com/',
        'Accept': '*/*',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!captionRes.ok) {
      return {
        success: false,
        status: 'error',
        error: `Subtitle download failed with HTTP ${captionRes.status}`,
      };
    }

    const rawCaptionText = await captionRes.text();
    const subtitles = parseRawSubtitles(rawCaptionText);

    if (subtitles.length === 0) {
      return {
        success: false,
        status: 'no_subtitles_available',
        error: 'Parsed subtitle items were empty',
      };
    }

    return {
      success: true,
      status: 'done',
      detectedLanguage: selectedSubtitle.languageCode || selectedSubtitle.language,
      subtitles,
      availableLanguages: subtitleInfos.map((s) => ({
        code: s.languageCode,
        name: s.language || s.languageCode,
        isOriginal: s.isOriginal,
        url: s.url,
      })),
    };
  } catch (err: any) {
    return {
      success: false,
      status: 'error',
      error: err?.message || 'Tier 1 fast scraping failed',
    };
  }
}
