import { describe, it, expect, vi, beforeEach } from 'vitest';
import { app } from '../src/index';
import { Env } from '../src/types';
import * as fastScraper from '../src/services/fastScraper';
import * as mirrorScraper from '../src/services/mirrorScraper';

describe('GET /api/v1/subtitles (Public Developer API)', () => {
  let mockKV: Record<string, string>;
  let mockR2: Record<string, string>;
  let mockEnv: Env;

  beforeEach(() => {
    mockKV = {};
    mockR2 = {};
    mockEnv = {
      MYBROWSER: {},
      DB: {
        prepare: vi.fn(() => ({
          bind: vi.fn(() => ({
            first: vi.fn(async () => null),
            all: vi.fn(async () => ({ results: [] })),
            run: vi.fn(async () => ({})),
          })),
        })),
      } as any,
      BUCKET: {
        get: vi.fn(async (key: string) => {
          const content = mockR2[key];
          if (!content) return null;
          return {
            body: content,
            text: async () => content,
            httpEtag: 'dummy-etag',
            writeHttpMetadata: vi.fn(),
          };
        }),
        put: vi.fn(async (key: string, value: string) => {
          mockR2[key] = value;
        }),
      } as any,
      KV_CACHE: {
        get: vi.fn(async (key: string) => {
          const val = mockKV[key];
          if (!val) return null;
          try {
            return JSON.parse(val);
          } catch {
            return val;
          }
        }),
        put: vi.fn(async (key: string, val: string) => {
          mockKV[key] = val;
        }),
      } as any,
      QUEUE: {
        send: vi.fn(async () => {}),
      } as any,
      ENVIRONMENT: 'test',
    };
    vi.restoreAllMocks();
  });

  it('rejects missing url parameter with 400', async () => {
    const res = await app.request('/api/v1/subtitles', {}, mockEnv);
    expect(res.status).toBe(400);
    const data = (await res.json()) as any;
    expect(data.error).toContain('Missing required query parameter "url"');
  });

  it('rejects invalid format parameter with 400', async () => {
    const res = await app.request(
      '/api/v1/subtitles?url=https://www.tiktok.com/@user/video/7051698610072833326&format=mp4',
      {},
      mockEnv
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as any;
    expect(data.error).toContain('Invalid format');
  });

  it('returns cached data as JSON by default', async () => {
    mockKV['cache:video:7051698610072833326'] = JSON.stringify({
      jobId: 'cached-job-1',
      videoId: '7051698610072833326',
      status: 'done',
      language: 'en-US',
      transcript: 'Hello from cached transcript',
      subtitles: [{ start: 0, end: 2000, text: 'Hello from cached transcript' }],
      availableLanguages: [{ code: 'en-US', name: 'English' }],
    });

    const res = await app.request(
      '/api/v1/subtitles?url=https://www.tiktok.com/@user/video/7051698610072833326',
      {},
      mockEnv
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.success).toBe(true);
    expect(data.videoId).toBe('7051698610072833326');
    expect(data.language).toBe('en-US');
    expect(data.transcript).toBe('Hello from cached transcript');
    expect(data.subtitles).toHaveLength(1);
    expect(data.downloads.srt).toContain('/api/download/');
  });

  it('returns plain text formats (srt, vtt, txt) directly when requested', async () => {
    mockKV['cache:video:7051698610072833326'] = JSON.stringify({
      jobId: 'cached-job-1',
      videoId: '7051698610072833326',
      status: 'done',
      language: 'en-US',
      transcript: 'Hello plain text',
      subtitles: [{ start: 1000, end: 3000, text: 'Hello plain text' }],
    });

    // Format: SRT
    const resSrt = await app.request(
      '/api/v1/subtitles?url=https://www.tiktok.com/@user/video/7051698610072833326&format=srt',
      {},
      mockEnv
    );
    expect(resSrt.status).toBe(200);
    expect(resSrt.headers.get('Content-Type')).toContain('text/plain');
    const srtText = await resSrt.text();
    expect(srtText).toContain('00:00:01,000 --> 00:00:03,000\nHello plain text');

    // Format: VTT
    const resVtt = await app.request(
      '/api/v1/subtitles?url=https://www.tiktok.com/@user/video/7051698610072833326&format=vtt',
      {},
      mockEnv
    );
    expect(resVtt.status).toBe(200);
    expect(resVtt.headers.get('Content-Type')).toContain('text/vtt');
    const vttText = await resVtt.text();
    expect(vttText).toContain('WEBVTT');

    // Format: TXT
    const resTxt = await app.request(
      '/api/v1/subtitles?url=https://www.tiktok.com/@user/video/7051698610072833326&format=txt',
      {},
      mockEnv
    );
    expect(resTxt.status).toBe(200);
    const txtText = await resTxt.text();
    expect(txtText).toBe('Hello plain text');
  });

  it('executes Tier 1 and returns subtitles on fresh video URL', async () => {
    vi.spyOn(fastScraper, 'scrapeFastSubtitles').mockResolvedValueOnce({
      success: true,
      status: 'done',
      detectedLanguage: 'en-US',
      subtitles: [{ start: 500, end: 1500, text: 'Live fresh extracted caption' }],
      availableLanguages: [{ code: 'en-US', name: 'English' }],
    });

    const res = await app.request(
      '/api/v1/subtitles?url=https://www.tiktok.com/@creator/video/7123456789012345678',
      {},
      mockEnv
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.success).toBe(true);
    expect(data.videoId).toBe('7123456789012345678');
    expect(data.transcript).toBe('Live fresh extracted caption');
  });

  it('fails with 404 without triggering Tier 3 queue if Tier 1 and Tier 2 fail', async () => {
    vi.spyOn(fastScraper, 'scrapeFastSubtitles').mockResolvedValueOnce({
      success: false,
      status: 'no_subtitles_available',
    });
    vi.spyOn(mirrorScraper, 'scrapeMirrorSubtitles').mockResolvedValueOnce({
      success: false,
      status: 'no_subtitles_available',
    });

    const res = await app.request(
      '/api/v1/subtitles?url=https://www.tiktok.com/@creator/video/7123456789012345678',
      {},
      mockEnv
    );

    expect(res.status).toBe(404);
    const data = (await res.json()) as any;
    expect(data.status).toBe('no_subtitles_available');
    // Ensure Queue was NOT called
    expect(mockEnv.QUEUE.send).not.toHaveBeenCalled();
  });

  it('enforces 30 requests per minute rate limit', async () => {
    const clientIp = '203.0.113.199';

    // Mock 30 requests already consumed in this minute window
    mockKV[`ratelimit:api_v1:${clientIp}:${Math.floor(Date.now() / 60000)}`] = '30';

    const res = await app.request(
      '/api/v1/subtitles?url=https://www.tiktok.com/@creator/video/7123456789012345678',
      {
        headers: { 'cf-connecting-ip': clientIp },
      },
      mockEnv
    );

    expect(res.status).toBe(429);
    const data = (await res.json()) as any;
    expect(data.error).toContain('Rate limit exceeded');
  });
});
