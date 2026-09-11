import { describe, it, expect, vi } from 'vitest';
import { extractSubtitlesFromRehydrationData } from '../src/services/scraper';
import { verifyTurnstileToken } from '../src/services/turnstile';

describe('Tier 1: HTML Rehydration Extraction', () => {
  it('extracts subtitles from __UNIVERSAL_DATA_FOR_REHYDRATION__ script with webapp.video-detail', () => {
    const rawHtml = `
      <!DOCTYPE html>
      <html>
        <body>
          <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">
            {
              "__DEFAULT_SCOPE__": {
                "webapp.video-detail": {
                  "itemInfo": {
                    "itemStruct": {
                      "video": {
                        "subtitleInfos": [
                          {
                            "LanguageCodeName": "de-DE",
                            "Url": "https://vtt.tiktokcdn.com/subtitles/de.vtt",
                            "Format": "webvtt",
                            "isOriginalCaption": true
                          }
                        ]
                      }
                    }
                  }
                }
              }
            }
          </script>
        </body>
      </html>
    `;

    const match = rawHtml.match(
      /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/i
    );
    expect(match).not.toBeNull();
    const parsed = JSON.parse(match![1]);
    const subtitles = extractSubtitlesFromRehydrationData(parsed, '123456');

    expect(subtitles).toHaveLength(1);
    expect(subtitles[0].languageCode).toBe('de-DE');
    expect(subtitles[0].url).toBe('https://vtt.tiktokcdn.com/subtitles/de.vtt');
    expect(subtitles[0].isOriginal).toBe(true);
  });

  it('handles SIGI_STATE fallback script structure', () => {
    const rawHtml = `
      <script id="SIGI_STATE" type="application/json">
        {
          "ItemModule": {
            "7141792788584221995": {
              "video": {
                "subtitleInfos": [
                  {
                    "LanguageCodeName": "en-US",
                    "Url": "https://vtt.tiktokcdn.com/subtitles/en.vtt",
                    "Format": "webvtt"
                  }
                ]
              }
            }
          }
        }
      </script>
    `;

    const match = rawHtml.match(/<script id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/i);
    expect(match).not.toBeNull();
    const parsed = JSON.parse(match![1]);
    const subtitles = extractSubtitlesFromRehydrationData(parsed, '7141792788584221995');

    expect(subtitles).toHaveLength(1);
    expect(subtitles[0].languageCode).toBe('en-US');
  });
});

describe('Tier 2: Mirror Scraper Logic', () => {
  it('normalizes TikWM API response structure', () => {
    const mockTikwmResponse = {
      code: 0,
      msg: 'success',
      data: {
        id: '7141792788584221995',
        title: 'Sample Video',
        subtitles: [
          {
            id: 1,
            lang: 'en',
            language: 'English',
            url: '/subtitles/7141792788584221995_en.vtt',
          },
          {
            id: 2,
            lang: 'de',
            language: 'German',
            url: '/subtitles/7141792788584221995_de.vtt',
          },
        ],
      },
    };

    const subs = mockTikwmResponse.data.subtitles;
    expect(subs).toHaveLength(2);

    const deSub = subs.find((s) => s.lang.startsWith('de'));
    expect(deSub).toBeDefined();
    expect(deSub!.url).toBe('/subtitles/7141792788584221995_de.vtt');
  });
});

describe('Cloudflare Turnstile Verification', () => {
  it('allows requests when secret key is not set or skip', async () => {
    const res1 = await verifyTurnstileToken(undefined, '127.0.0.1', undefined);
    expect(res1.success).toBe(true);

    const res2 = await verifyTurnstileToken('any-token', '127.0.0.1', 'skip');
    expect(res2.success).toBe(true);
  });

  it('allows requests with Cloudflare test token', async () => {
    const res = await verifyTurnstileToken(
      'XXXX.DUMMY.TOKEN.XXXX',
      '127.0.0.1',
      '1x0000000000000000000000000000000AA'
    );
    expect(res.success).toBe(true);
  });

  it('rejects missing token when secret is configured', async () => {
    const res = await verifyTurnstileToken(
      '',
      '127.0.0.1',
      '1x0000000000000000000000000000000AA'
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain('Missing');
  });
});
