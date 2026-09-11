import puppeteer from '@cloudflare/puppeteer';
import { Env, ExtractedSubtitleInfo, ScrapeResult } from '../types';
import { parseRawSubtitles } from './converter';

const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/**
 * Defensively extracts subtitle information from TikTok's rehydration JSON structure.
 * Recursively inspects data structures and targets known TikTok schema variations.
 */
export function extractSubtitlesFromRehydrationData(data: any, videoId: string): ExtractedSubtitleInfo[] {
  if (!data) return [];

  const found: ExtractedSubtitleInfo[] = [];
  const visited = new Set();

  function searchDeep(node: any) {
    if (!node || typeof node !== 'object' || visited.has(node)) return;
    visited.add(node);

    // Direct match: node looks like a TikTok subtitle item
    const possibleUrl = node.Url || node.url || node.UrlExpire || node.urlExpire;
    if (
      possibleUrl &&
      typeof possibleUrl === 'string' &&
      (possibleUrl.startsWith('http://') || possibleUrl.startsWith('https://')) &&
      (node.LanguageCodeName || node.LanguageId || node.language || node.Format || node.format || possibleUrl.includes('/subtitle') || possibleUrl.includes('tos-maliva'))
    ) {
      const alreadyHas = found.some((s) => s.url === possibleUrl);
      if (!alreadyHas) {
        found.push({
          id: String(node.Id || node.id || node.LanguageId || ''),
          language: node.LanguageCodeName || node.language || 'Original',
          languageCode: node.LanguageCodeName || node.lang || node.language || 'und',
          format: node.Format || node.format || (possibleUrl.includes('.json') ? 'json' : 'webvtt'),
          url: possibleUrl,
          isOriginal: Boolean(node.isOriginalCaption || node.Source === 'ASR'),
        });
      }
    }

    // Traverse arrays and nested objects
    if (Array.isArray(node)) {
      for (const item of node) searchDeep(item);
    } else {
      for (const key of Object.keys(node)) {
        searchDeep(node[key]);
      }
    }
  }

  const defaultScope = data['__DEFAULT_SCOPE__'] || data;
  const videoDetail =
    defaultScope['webapp.video-detail'] ||
    defaultScope['webapp.videoDetail'] ||
    defaultScope['videoDetail'] ||
    data['webapp.video-detail'] ||
    data.videoDetail;

  if (videoDetail) {
    searchDeep(videoDetail);
  }

  if (found.length === 0) {
    searchDeep(defaultScope);
  }

  return found;
}

/**
 * Cloudflare Browser Rendering scraper for TikTok.
 * Runs in a headless Chrome session managed by Cloudflare.
 */
export async function scrapeTikTokCaptions(
  env: Env,
  videoId: string,
  resolvedUrl: string
): Promise<ScrapeResult> {
  let browser: any = null;

  try {
    // Launch headless browser session via Cloudflare Browser Rendering API
    browser = await puppeteer.launch(env.MYBROWSER, {
      keep_alive: 60000,
    });

    const page = await browser.newPage();

    // Set standard desktop viewport and User-Agent
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(DESKTOP_USER_AGENT);

    // Set custom request headers
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
    });

    // If optional custom session cookie is provided via environment secret
    if (env.TIKTOK_COOKIE) {
      const cookies = env.TIKTOK_COOKIE.split(';')
        .map((pair) => pair.trim())
        .filter(Boolean)
        .map((pair) => {
          const [name, ...val] = pair.split('=');
          return {
            name: name.trim(),
            value: val.join('=').trim(),
            domain: '.tiktok.com',
            path: '/',
          };
        });
      if (cookies.length > 0) {
        await page.setCookie(...cookies);
      }
    }

    const targetUrl = `https://www.tiktok.com/@i/video/${videoId}`;

    // Navigate to TikTok video page
    let response: any = null;
    try {
      response = await page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
    } catch (navErr) {
      console.warn('Navigation timeout or error, checking page state anyway:', navErr);
    }

    // Wait 2.5 seconds for client-side hydration scripts to execute
    await page.waitForTimeout(2500);

    const pageContent = await page.content();
    const httpStatus = response ? response.status() : 200;

    // Check 1: Blocked or Captcha Detection
    const isBlocked =
      httpStatus === 403 ||
      pageContent.includes('verify-bar') ||
      pageContent.includes('captcha_verify_container') ||
      pageContent.includes('sec-sdk-captcha') ||
      pageContent.includes('verify-center') ||
      pageContent.includes('TikTok - Make Your Day') && pageContent.includes('Access Denied');

    if (isBlocked) {
      return {
        success: false,
        status: 'failed_blocked',
        error: 'TikTok security verification or captcha triggered',
      };
    }

    // Check 2: Video Private or Deleted Detection
    const isUnavailable =
      httpStatus === 404 ||
      pageContent.includes('video-unavailable') ||
      pageContent.includes('This video is unavailable') ||
      pageContent.includes('Video is private') ||
      pageContent.includes('"statusCode":10204') ||
      pageContent.includes('"statusCode":10222');

    if (isUnavailable) {
      return {
        success: false,
        status: 'video_private_or_deleted',
        error: 'Video is private, deleted, or unavailable',
      };
    }

    // Check 3: Extract Hydration Data from Scripts
    let subtitleInfos: ExtractedSubtitleInfo[] = [];

    const hydrationDataStr = await page.evaluate(() => {
      const scriptTag =
        document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__') ||
        document.getElementById('SIGI_STATE');
      return scriptTag ? scriptTag.textContent : null;
    });

    if (hydrationDataStr) {
      try {
        const parsed = JSON.parse(hydrationDataStr);
        const scope = parsed['__DEFAULT_SCOPE__'] || parsed;
        console.log('[Scraper] Top scope keys:', Object.keys(scope));
        const vDetail = scope['webapp.videoDetail'] || scope['videoDetail'];
        console.log('[Scraper] VideoDetail keys:', vDetail ? Object.keys(vDetail) : 'none');
        if (vDetail?.itemInfo?.itemStruct) {
          console.log('[Scraper] ItemStruct keys:', Object.keys(vDetail.itemInfo.itemStruct));
          console.log('[Scraper] Video keys:', Object.keys(vDetail.itemInfo.itemStruct.video || {}));
        }
        subtitleInfos = extractSubtitlesFromRehydrationData(parsed, videoId);
        console.log(`[Scraper] Extracted ${subtitleInfos.length} subtitle infos`);
      } catch (err) {
        console.warn('Failed to parse primary hydration JSON script:', err);
      }
    }

    // Check 4: Fallback HTML regex if DOM evaluate missed it
    if (subtitleInfos.length === 0) {
      const regexMatch = pageContent.match(
        /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/i
      );
      if (regexMatch && regexMatch[1]) {
        try {
          const parsed = JSON.parse(regexMatch[1]);
          subtitleInfos = extractSubtitlesFromRehydrationData(parsed, videoId);
        } catch {
          // Ignore
        }
      }
    }

    // Check 5: Internal API fallback inside page context (inheriting cookies & tokens)
    if (subtitleInfos.length === 0) {
      try {
        const apiFallbackData = await page.evaluate(async (vid: string) => {
          try {
            const apiUrl = `/api/item/detail/?itemId=${vid}`;
            const res = await fetch(apiUrl, {
              headers: { Accept: 'application/json' },
              credentials: 'include',
            });
            if (res.ok) {
              return await res.json();
            }
          } catch {
            return null;
          }
          return null;
        }, videoId);

        if (apiFallbackData) {
          subtitleInfos = extractSubtitlesFromRehydrationData(apiFallbackData, videoId);
        }
      } catch (err) {
        console.warn('API fallback evaluation failed:', err);
      }
    }

    // If no subtitles were found
    if (subtitleInfos.length === 0) {
      return {
        success: false,
        status: 'no_subtitles_available',
        error: 'No captions or subtitles available for this video',
      };
    }

    // Select preferred subtitle: original/ASR or first available
    const selectedSubtitle =
      subtitleInfos.find((s) => s.isOriginal) ||
      subtitleInfos.find((s) => s.languageCode.startsWith('de') || s.languageCode.startsWith('en')) ||
      subtitleInfos[0];

    // Download subtitle content DIRECTLY inside the Puppeteer page context
    // to preserve all cookies, signatures, and referers, avoiding CDN 403 Forbidden.
    const rawCaptionContent = await page.evaluate(async (captionUrl: string) => {
      const res = await fetch(captionUrl, {
        credentials: 'include',
        headers: {
          Accept: '*/*',
        },
      });
      if (!res.ok) {
        throw new Error(`Caption download failed with HTTP ${res.status}`);
      }
      return await res.text();
    }, selectedSubtitle.url);

    // Parse the downloaded caption into standardized SubtitleItems
    const parsedSubtitles = parseRawSubtitles(rawCaptionContent);

    if (parsedSubtitles.length === 0) {
      return {
        success: false,
        status: 'no_subtitles_available',
        error: 'Subtitle stream was empty or could not be parsed',
      };
    }

    return {
      success: true,
      status: 'done',
      detectedLanguage: selectedSubtitle.languageCode || selectedSubtitle.language,
      subtitles: parsedSubtitles,
      availableLanguages: subtitleInfos.map((s) => ({
        code: s.languageCode,
        name: s.language || s.languageCode,
        isOriginal: s.isOriginal,
        url: s.url,
      })),
    };
  } catch (err: any) {
    console.error('Scraper exception:', err);
    return {
      success: false,
      status: 'error',
      error: err?.message || 'Unexpected scraping error',
    };
  } finally {
    // Crucial: Always close browser to release session limit back to the account pool
    if (browser) {
      try {
        await browser.close();
      } catch (closeErr) {
        console.error('Error closing browser session:', closeErr);
      }
    }
  }
}
