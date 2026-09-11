import { ScrapeResult, SubtitleItem } from '../types';
import { parseRawSubtitles } from './converter';

const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const FETCH_TIMEOUT_MS = 4000;

/**
 * TIER 2: Public Mirror Fallback (TikWM API)
 * Queries the public TikWM API when Tier 1 is blocked or misses hydration scripts.
 * Returns parsed captions in under 400ms without browser rendering.
 */
export async function scrapeMirrorSubtitles(
  resolvedUrl: string,
  videoId: string
): Promise<ScrapeResult> {
  try {
    const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(resolvedUrl)}`;

    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'User-Agent': DESKTOP_USER_AGENT,
        'Accept': 'application/json, text/plain, */*',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      return {
        success: false,
        status: 'error',
        error: `TikWM API returned HTTP ${response.status}`,
      };
    }

    const payload = (await response.json()) as any;

    if (payload.code !== 0 || !payload.data) {
      return {
        success: false,
        status: 'error',
        error: payload.msg || 'TikWM reported unready or failed video',
      };
    }

    const data = payload.data;

    // Check data.subtitles or data.video.subtitles
    const rawSubtitles =
      data.subtitles ||
      data.video?.subtitles ||
      data.subtitle_infos ||
      data.video?.subtitle_infos;

    if (!Array.isArray(rawSubtitles) || rawSubtitles.length === 0) {
      return {
        success: false,
        status: 'no_subtitles_available',
        error: 'No subtitles available in TikWM mirror response',
      };
    }

    // Select preferred language (de, en, or first available)
    const selectedSub =
      rawSubtitles.find((s: any) => (s.lang || s.language || '').toLowerCase().startsWith('de')) ||
      rawSubtitles.find((s: any) => (s.lang || s.language || '').toLowerCase().startsWith('en')) ||
      rawSubtitles[0];

    const subUrl = selectedSub?.url || selectedSub?.Url;
    if (!subUrl) {
      return {
        success: false,
        status: 'no_subtitles_available',
        error: 'TikWM subtitle URL missing',
      };
    }

    // Ensure full URL
    const fullUrl = subUrl.startsWith('http') ? subUrl : `https://www.tikwm.com${subUrl}`;

    // Download the subtitle content
    const captionRes = await fetch(fullUrl, {
      headers: {
        'User-Agent': DESKTOP_USER_AGENT,
        'Accept': '*/*',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!captionRes.ok) {
      return {
        success: false,
        status: 'error',
        error: `Failed to download TikWM subtitle file: HTTP ${captionRes.status}`,
      };
    }

    const rawCaptionText = await captionRes.text();
    const subtitles: SubtitleItem[] = parseRawSubtitles(rawCaptionText);

    if (subtitles.length === 0) {
      return {
        success: false,
        status: 'no_subtitles_available',
        error: 'Parsed TikWM subtitles were empty',
      };
    }

    return {
      success: true,
      status: 'done',
      detectedLanguage: selectedSub.lang || selectedSub.language || 'Original',
      subtitles,
      availableLanguages: rawSubtitles.map((s: any) => ({
        code: s.lang || s.language || 'und',
        name: s.language || s.lang || 'Original',
        url: s.url?.startsWith('http') ? s.url : (s.url ? `https://www.tikwm.com${s.url}` : undefined),
      })),
    };
  } catch (err: any) {
    return {
      success: false,
      status: 'error',
      error: err?.message || 'Tier 2 mirror scraping failed',
    };
  }
}
