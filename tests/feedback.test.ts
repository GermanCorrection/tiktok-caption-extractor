import { describe, it, expect, vi, beforeEach } from 'vitest';
import { app } from '../src/index';
import { Env } from '../src/types';

describe('POST /api/feedback', () => {
  let mockKV: Record<string, string>;
  let mockEnv: Env;

  beforeEach(() => {
    mockKV = {};
    mockEnv = {
      MYBROWSER: {},
      DB: {} as any,
      BUCKET: {} as any,
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

  it('rejects empty or missing message with 400', async () => {
    const res = await app.request(
      '/api/feedback',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      mockEnv
    );

    expect(res.status).toBe(400);
    const data = (await res.json()) as any;
    expect(data.error).toContain('at least 5 characters');
  });

  it('rejects messages shorter than 5 characters with 400', async () => {
    const res = await app.request(
      '/api/feedback',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Hi!' }),
      },
      mockEnv
    );

    expect(res.status).toBe(400);
    const data = (await res.json()) as any;
    expect(data.error).toContain('at least 5 characters');
  });

  it('rejects messages longer than 1500 characters with 400', async () => {
    const longMessage = 'a'.repeat(1501);
    const res = await app.request(
      '/api/feedback',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: longMessage }),
      },
      mockEnv
    );

    expect(res.status).toBe(400);
    const data = (await res.json()) as any;
    expect(data.error).toContain('exceed 1500 characters');
  });

  it('succeeds without Discord webhook configured (graceful fallback)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await app.request(
      '/api/feedback',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Tolles Tool, funktioniert super!',
          optionalContact: 'user@example.com',
        }),
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.success).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Feedback] DISCORD_WEBHOOK_URL not configured'),
      expect.any(String)
    );
  });

  it('sends formatted embed to Discord webhook when configured', async () => {
    const webhookUrl = 'https://discord.com/api/webhooks/test/dummy-token';
    mockEnv.DISCORD_WEBHOOK_URL = webhookUrl;

    let interceptedUrl = '';
    let interceptedOptions: any = null;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options: any) => {
        interceptedUrl = url;
        interceptedOptions = options;
        return {
          ok: true,
          status: 204,
          text: async () => '',
        } as Response;
      })
    );

    const res = await app.request(
      '/api/feedback',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Video https://vm.tiktok.com/ZGe12345/ hat keine Untertitel extrahiert.',
          optionalContact: 'vito#1234',
        }),
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.success).toBe(true);

    expect(interceptedUrl).toBe(webhookUrl);
    expect(interceptedOptions.method).toBe('POST');
    expect(interceptedOptions.headers['Content-Type']).toBe('application/json');

    const sentBody = JSON.parse(interceptedOptions.body);
    expect(sentBody.embeds).toBeDefined();
    expect(sentBody.embeds).toHaveLength(1);

    const embed = sentBody.embeds[0];
    expect(embed.title).toContain('Neues Nutzer-Feedback');
    expect(embed.color).toBe(5793266);
    expect(embed.fields).toEqual([
      {
        name: 'Nachricht',
        value: 'Video https://vm.tiktok.com/ZGe12345/ hat keine Untertitel extrahiert.',
      },
      {
        name: 'Kontakt (optional)',
        value: 'vito#1234',
      },
    ]);
    expect(embed.timestamp).toBeDefined();
  });

  it('uses default contact text if optionalContact is omitted', async () => {
    const webhookUrl = 'https://discord.com/api/webhooks/test/dummy-token';
    mockEnv.DISCORD_WEBHOOK_URL = webhookUrl;

    let sentBody: any = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, options: any) => {
        sentBody = JSON.parse(options.body);
        return { ok: true, status: 204 } as Response;
      })
    );

    const res = await app.request(
      '/api/feedback',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Anonymes Feedback ohne Kontaktangabe.',
        }),
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    expect(sentBody.embeds[0].fields[1].value).toBe('Keine Angabe');
  });

  it('enforces rate limit of 3 feedback messages per 15 minutes', async () => {
    const clientIp = '198.51.100.42';

    // 1st request
    const res1 = await app.request(
      '/api/feedback',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'cf-connecting-ip': clientIp,
        },
        body: JSON.stringify({ message: 'Erstes Feedback' }),
      },
      mockEnv
    );
    expect(res1.status).toBe(200);

    // 2nd request
    const res2 = await app.request(
      '/api/feedback',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'cf-connecting-ip': clientIp,
        },
        body: JSON.stringify({ message: 'Zweites Feedback' }),
      },
      mockEnv
    );
    expect(res2.status).toBe(200);

    // 3rd request
    const res3 = await app.request(
      '/api/feedback',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'cf-connecting-ip': clientIp,
        },
        body: JSON.stringify({ message: 'Drittes Feedback' }),
      },
      mockEnv
    );
    expect(res3.status).toBe(200);

    // 4th request -> Rate Limited!
    const res4 = await app.request(
      '/api/feedback',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'cf-connecting-ip': clientIp,
        },
        body: JSON.stringify({ message: 'Viertes Feedback (zu viel)' }),
      },
      mockEnv
    );
    expect(res4.status).toBe(429);
    const data4 = (await res4.json()) as any;
    expect(data4.error).toContain('rate limit exceeded');
  });
});
