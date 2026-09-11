import { describe, it, expect } from 'vitest';
import { extractVideoId, isShortLink } from '../src/services/resolver';
import { extractSubtitlesFromRehydrationData } from '../src/services/scraper';

describe('TikTok Resolver', () => {
  it('extracts video ID from standard desktop URLs', () => {
    const url = 'https://www.tiktok.com/@tiktok/video/7391234567890123456?is_from_webapp=1';
    expect(extractVideoId(url)).toBe('7391234567890123456');
  });

  it('extracts video ID from photo URLs', () => {
    const url = 'https://www.tiktok.com/@creator/photo/7388776655443322110';
    expect(extractVideoId(url)).toBe('7388776655443322110');
  });

  it('extracts video ID from query parameters', () => {
    const url = 'https://m.tiktok.com/v/?item_id=7391234567890123456';
    expect(extractVideoId(url)).toBe('7391234567890123456');
  });

  it('detects short links correctly', () => {
    expect(isShortLink('https://vm.tiktok.com/ZGeXXXXX/')).toBe(true);
    expect(isShortLink('https://vt.tiktok.com/ZSyYYYYY/')).toBe(true);
    expect(isShortLink('https://v.tiktok.com/ZSyYYYYY/')).toBe(true);
    expect(isShortLink('https://www.tiktok.com/t/ZTR234/')).toBe(true);
    expect(isShortLink('https://www.tiktok.com/@user/video/7391234567890123456')).toBe(false);
  });

  it('extracts video ID from mobile m.tiktok.com links with query strings', () => {
    const url = 'https://m.tiktok.com/v/7051698610072833326.html?is_from_webapp=1&sender_device=pc&_r=1';
    expect(extractVideoId(url)).toBe('7051698610072833326');
  });

  it('handles standard URLs with complex tracking parameters', () => {
    const url = 'https://www.tiktok.com/@user/video/7031585986912013574?lang=en&q=dance&t=12345';
    expect(extractVideoId(url)).toBe('7031585986912013574');
  });
});

describe('Defensive Scraper Hydration Extraction', () => {
  it('extracts subtitle URLs from __DEFAULT_SCOPE__ schema', () => {
    const fixture = {
      __DEFAULT_SCOPE__: {
        'webapp.videoDetail': {
          itemInfo: {
            itemStruct: {
              video: {
                subtitleInfos: [
                  {
                    Id: '123',
                    LanguageCodeName: 'de-DE',
                    Format: 'webvtt',
                    Url: 'https://p16-va.tiktokcdn.com/subtitles/de.vtt',
                    isOriginalCaption: true,
                  },
                  {
                    Id: '124',
                    LanguageCodeName: 'en-US',
                    Format: 'webvtt',
                    Url: 'https://p16-va.tiktokcdn.com/subtitles/en.vtt',
                    isOriginalCaption: false,
                  },
                ],
              },
            },
          },
        },
      },
    };

    const extracted = extractSubtitlesFromRehydrationData(fixture, '7391234567890123456');
    expect(extracted).toHaveLength(2);
    expect(extracted[0].languageCode).toBe('de-DE');
    expect(extracted[0].url).toBe('https://p16-va.tiktokcdn.com/subtitles/de.vtt');
    expect(extracted[0].isOriginal).toBe(true);
  });

  it('handles empty or malformed hydration object without throwing', () => {
    expect(extractSubtitlesFromRehydrationData(null, '123')).toEqual([]);
    expect(extractSubtitlesFromRehydrationData({}, '123')).toEqual([]);
    expect(extractSubtitlesFromRehydrationData({ somethingElse: true }, '123')).toEqual([]);
  });
});
