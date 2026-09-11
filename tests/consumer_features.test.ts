import { describe, it, expect, vi, beforeEach } from 'vitest';
import { app } from '../src/index';
import { Env } from '../src/types';

describe('Consumer Features & API Endpoints', () => {
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
            first: vi.fn(async () => ({
              id: 'job-123',
              video_id: '7051698610072833326',
              status: 'done',
              language: 'eng-US',
              srt_key: 'subtitles/7051698610072833326/eng-US.srt',
              vtt_key: 'subtitles/7051698610072833326/eng-US.vtt',
              caption_count: 2,
              created_at: 1000,
              updated_at: 1000,
            })),
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
        get: vi.fn(async (key: string) => mockKV[key] || null),
        put: vi.fn(async (key: string, val: string) => {
          mockKV[key] = val;
        }),
      } as any,
      QUEUE: {} as any,
      ENVIRONMENT: 'test',
    };
    vi.restoreAllMocks();
  });

  it('downloads .txt format directly from stored file', async () => {
    mockR2['subtitles/7051698610072833326/eng-US.txt'] = 'Line one\nLine two';

    const res = await app.request('/api/download/job-123/txt', {}, mockEnv);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/plain');
    expect(res.headers.get('Content-Disposition')).toContain('.txt');
    const text = await res.text();
    expect(text).toBe('Line one\nLine two');
  });

  it('downloads .txt format converting from .srt on the fly if .txt not stored', async () => {
    mockR2['subtitles/7051698610072833326/eng-US.srt'] =
      '1\n00:00:01,000 --> 00:00:03,000\nHello World\n\n2\n00:00:04,000 --> 00:00:06,000\nSecond Line\n';

    const res = await app.request('/api/download/job-123/txt', {}, mockEnv);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/plain');
    const text = await res.text();
    expect(text).toBe('Hello World\nSecond Line');
  });

  it('converts alternate language subtitle on demand via /api/convert-subtitle', async () => {
    const rawVtt = `WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nHola Mundo\n`;

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => rawVtt,
      }))
    );

    const res = await app.request(
      '/api/convert-subtitle',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://vtt.tiktokcdn.com/spanish.vtt' }),
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.success).toBe(true);
    expect(data.transcript).toBe('Hola Mundo');
    expect(data.subtitles).toHaveLength(1);
    expect(data.subtitles[0].text).toBe('Hola Mundo');
    expect(data.srt).toContain('00:00:01,000 --> 00:00:03,000\nHola Mundo');
  });
});
