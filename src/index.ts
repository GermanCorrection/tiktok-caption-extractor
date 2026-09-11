import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { AvailableLanguage, Env, QueueMessage, SubtitleItem } from './types';
import { resolveTikTokUrl } from './services/resolver';
import { checkRateLimit, getClientIp } from './services/ratelimit';
import { createJob, getJobById, getLatestJobByVideoId, updateJobStatus } from './db/queries';
import { scrapeTikTokCaptions } from './services/scraper';
import { scrapeFastSubtitles } from './services/fastScraper';
import { scrapeMirrorSubtitles } from './services/mirrorScraper';
import { verifyTurnstileToken } from './services/turnstile';
import { convertToPlainText, convertToSrt, convertToVtt, parseRawSubtitles } from './services/converter';

export const app = new Hono<{ Bindings: Env }>();

// Enable CORS for API routes
app.use('/api/*', cors());

/**
 * Health check endpoint
 */
app.get('/api/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'tiktok-caption-extractor',
    tiers: ['tier1_fast', 'tier2_mirror', 'tier3_browser'],
  });
});

/**
 * Helper to store subtitles into R2, D1, and KV
 */
async function persistSubtitles(
  env: Env,
  jobId: string,
  videoId: string,
  language: string,
  subtitles: any[],
  availableLanguages?: AvailableLanguage[]
): Promise<{ srtKey: string; vttKey: string; txtKey: string; transcript: string }> {
  const lang = language || 'und';
  const srtContent = convertToSrt(subtitles);
  const vttContent = convertToVtt(subtitles);
  const txtContent = convertToPlainText(subtitles);

  const srtKey = `subtitles/${videoId}/${lang}.srt`;
  const vttKey = `subtitles/${videoId}/${lang}.vtt`;
  const txtKey = `subtitles/${videoId}/${lang}.txt`;

  // 1. Store in Cloudflare R2
  await env.BUCKET.put(srtKey, srtContent, {
    httpMetadata: { contentType: 'text/plain; charset=utf-8' },
  });
  await env.BUCKET.put(vttKey, vttContent, {
    httpMetadata: { contentType: 'text/vtt; charset=utf-8' },
  });
  await env.BUCKET.put(txtKey, txtContent, {
    httpMetadata: { contentType: 'text/plain; charset=utf-8' },
  });

  // 2. Update Cloudflare D1
  await updateJobStatus(env.DB, jobId, 'done', {
    language: lang,
    srtKey,
    vttKey,
    captionCount: subtitles.length,
  });

  // 3. Cache in Cloudflare KV (7 days TTL)
  await env.KV_CACHE.put(
    `cache:video:${videoId}`,
    JSON.stringify({
      jobId,
      videoId,
      status: 'done',
      language: lang,
      srtKey,
      vttKey,
      txtKey,
      captionCount: subtitles.length,
      availableLanguages: availableLanguages || [],
      transcript: txtContent,
      subtitles,
      timestamp: Date.now(),
    }),
    { expirationTtl: 86400 * 7 }
  );

  return { srtKey, vttKey, txtKey, transcript: txtContent };
}

interface SubmitRequestBody {
  url?: string;
  'cf-turnstile-response'?: string;
  turnstileToken?: string;
}

/**
 * 1. POST /api/submit
 * 3-Tier Multi-Strategy Waterfall:
 * - Tier 1: Fast HTTP Rehydration (<350ms)
 * - Tier 2: Public TikWM Mirror Fallback (<450ms)
 * - Tier 3: Browser Rendering via Queue (Ultimate fallback)
 */
app.post('/api/submit', async (c) => {
  try {
    const body: SubmitRequestBody = await c.req.json<SubmitRequestBody>().catch(() => ({} as SubmitRequestBody));

    const inputUrl = typeof body?.url === 'string' ? body.url.trim() : undefined;
    const turnstileToken =
      typeof body?.['cf-turnstile-response'] === 'string'
        ? body['cf-turnstile-response']
        : typeof body?.turnstileToken === 'string'
        ? body.turnstileToken
        : undefined;

    if (!inputUrl) {
      return c.json({ error: 'Missing or empty "url" field' }, 400);
    }

    // 1. Rate Limiting via KV (keyed by secure CF-Connecting-IP)
    const clientIp = getClientIp(c.req.raw.headers);
    const maxPerMin = parseInt(c.env.MAX_REQUESTS_PER_MINUTE || '15', 10);
    const rateLimit = await checkRateLimit(c.env.KV_CACHE, clientIp, maxPerMin);

    c.header('X-RateLimit-Limit', rateLimit.limit.toString());
    c.header('X-RateLimit-Remaining', rateLimit.remaining.toString());

    if (!rateLimit.allowed) {
      return c.json(
        {
          error: 'Rate limit exceeded. Please wait before submitting more links.',
          resetSeconds: rateLimit.resetSeconds,
        },
        429
      );
    }

    // 2. Cloudflare Turnstile Bot Verification
    const turnstileResult = await verifyTurnstileToken(
      turnstileToken,
      clientIp,
      c.env.TURNSTILE_SECRET_KEY
    );

    if (!turnstileResult.success) {
      return c.json(
        {
          error: 'Bot verification failed',
          details: turnstileResult.error,
        },
        403
      );
    }

    // 3. Resolve shortlink & extract Video ID
    let resolved;
    try {
      resolved = await resolveTikTokUrl(inputUrl);
    } catch (err: any) {
      return c.json(
        {
          error: 'Invalid TikTok URL or could not extract video ID',
          details: err?.message,
        },
        400
      );
    }

    const { videoId, resolvedUrl } = resolved;

    // 4. IDEMPOTENCY: Check KV cache first
    const kvCached = (await c.env.KV_CACHE.get(`cache:video:${videoId}`, {
      type: 'json',
    })) as any;

    if (kvCached && kvCached.status === 'done') {
      return c.json({
        success: true,
        jobId: kvCached.jobId,
        videoId,
        status: 'done',
        language: kvCached.language,
        captionCount: kvCached.captionCount || 0,
        transcript: kvCached.transcript,
        subtitles: kvCached.subtitles,
        languages: kvCached.availableLanguages || [],
        cached: true,
        tier: 'cache',
        downloads: {
          srt: `/api/download/${kvCached.jobId}/srt`,
          vtt: `/api/download/${kvCached.jobId}/vtt`,
          txt: `/api/download/${kvCached.jobId}/txt`,
        },
      });
    }

    // Check D1 database for an existing completed job
    const existingJob = await getLatestJobByVideoId(c.env.DB, videoId);
    if (existingJob && existingJob.status === 'done') {
      const cachedData = {
        jobId: existingJob.id,
        videoId,
        status: 'done',
        language: existingJob.language,
        srtKey: existingJob.srt_key,
        vttKey: existingJob.vtt_key,
        captionCount: existingJob.caption_count,
      };
      await c.env.KV_CACHE.put(
        `cache:video:${videoId}`,
        JSON.stringify(cachedData),
        { expirationTtl: 86400 * 7 }
      );

      return c.json({
        success: true,
        jobId: existingJob.id,
        videoId,
        status: 'done',
        language: existingJob.language,
        captionCount: existingJob.caption_count || 0,
        cached: true,
        tier: 'cache',
        downloads: {
          srt: `/api/download/${existingJob.id}/srt`,
          vtt: `/api/download/${existingJob.id}/vtt`,
          txt: `/api/download/${existingJob.id}/txt`,
        },
      });
    }

    // 5. Create initial job record in D1
    const jobId = crypto.randomUUID();
    await createJob(c.env.DB, {
      id: jobId,
      videoId,
      sourceUrl: inputUrl,
      resolvedUrl,
      status: 'processing',
    });

    // =========================================================================
    // TIER 1: Lightweight HTML Rehydration Fetch (<350ms, NO Headless Browser)
    // =========================================================================
    try {
      const t1 = await scrapeFastSubtitles(resolvedUrl, videoId, c.env.TIKTOK_COOKIE);
      if (t1.success && t1.subtitles && t1.subtitles.length > 0) {
        console.log(`[Waterfall] Tier 1 (Fast Rehydration) SUCCESS for video ${videoId}`);
        const persisted = await persistSubtitles(
          c.env,
          jobId,
          videoId,
          t1.detectedLanguage || 'und',
          t1.subtitles,
          t1.availableLanguages
        );

        return c.json({
          success: true,
          jobId,
          videoId,
          status: 'done',
          language: t1.detectedLanguage,
          captionCount: t1.subtitles.length,
          transcript: persisted.transcript,
          subtitles: t1.subtitles,
          languages: t1.availableLanguages || [],
          cached: false,
          tier: 'tier1_fast',
          downloads: {
            srt: `/api/download/${jobId}/srt`,
            vtt: `/api/download/${jobId}/vtt`,
            txt: `/api/download/${jobId}/txt`,
          },
        });
      }
      console.log(`[Waterfall] Tier 1 missed (${t1.status}: ${t1.error}), falling back to Tier 2...`);
    } catch (t1Err: any) {
      console.warn('[Waterfall] Tier 1 exception:', t1Err?.message);
    }

    // =========================================================================
    // TIER 2: Public Mirror Fallback via TikWM (<450ms, NO Headless Browser)
    // =========================================================================
    try {
      const t2 = await scrapeMirrorSubtitles(resolvedUrl, videoId);
      if (t2.success && t2.subtitles && t2.subtitles.length > 0) {
        console.log(`[Waterfall] Tier 2 (TikWM Mirror) SUCCESS for video ${videoId}`);
        const persisted = await persistSubtitles(
          c.env,
          jobId,
          videoId,
          t2.detectedLanguage || 'und',
          t2.subtitles,
          t2.availableLanguages
        );

        return c.json({
          success: true,
          jobId,
          videoId,
          status: 'done',
          language: t2.detectedLanguage,
          captionCount: t2.subtitles.length,
          transcript: persisted.transcript,
          subtitles: t2.subtitles,
          languages: t2.availableLanguages || [],
          cached: false,
          tier: 'tier2_mirror',
          downloads: {
            srt: `/api/download/${jobId}/srt`,
            vtt: `/api/download/${jobId}/vtt`,
            txt: `/api/download/${jobId}/txt`,
          },
        });
      }
      console.log(`[Waterfall] Tier 2 missed (${t2.status}: ${t2.error}), falling back to Tier 3...`);
    } catch (t2Err: any) {
      console.warn('[Waterfall] Tier 2 exception:', t2Err?.message);
    }

    // =========================================================================
    // TIER 3: Cloudflare Queue + Headless Browser Rendering (Ultimate Fallback)
    // =========================================================================
    console.log(`[Waterfall] Enqueueing Tier 3 Browser Rendering job for video ${videoId}`);
    await updateJobStatus(c.env.DB, jobId, 'queued');
    await c.env.QUEUE.send({
      jobId,
      videoId,
      resolvedUrl,
      sourceUrl: inputUrl,
    });

    return c.json({
      success: true,
      jobId,
      videoId,
      status: 'queued',
      cached: false,
      tier: 'tier3_browser',
    });
  } catch (err: any) {
    console.error('Submit route error:', err);
    return c.json(
      { error: 'Internal server error processing request', message: err?.message },
      500
    );
  }
});

/**
 * 2. GET /api/status/:jobId
 * Retrieves job status, language, caption count, and download endpoints.
 */
app.get('/api/status/:jobId', async (c) => {
  const jobId = c.req.param('jobId');
  if (!jobId) {
    return c.json({ error: 'Missing jobId parameter' }, 400);
  }

  const job = await getJobById(c.env.DB, jobId);
  if (!job) {
    return c.json({ error: 'Job not found' }, 404);
  }

  let transcript: string | undefined = undefined;
  let subtitles: any[] | undefined = undefined;
  let languages: any[] | undefined = undefined;

  if (job.status === 'done') {
    const cached = (await c.env.KV_CACHE.get(`cache:video:${job.video_id}`, { type: 'json' })) as any;
    if (cached) {
      transcript = cached.transcript;
      subtitles = cached.subtitles;
      languages = cached.availableLanguages;
    }
  }

  return c.json({
    id: job.id,
    videoId: job.video_id,
    status: job.status,
    errorMessage: job.error_message,
    language: job.language,
    captionCount: job.caption_count,
    transcript,
    subtitles,
    languages: languages || [],
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    downloads:
      job.status === 'done'
        ? {
            srt: `/api/download/${job.id}/srt`,
            vtt: `/api/download/${job.id}/vtt`,
            txt: `/api/download/${job.id}/txt`,
          }
        : null,
  });
});

/**
 * 3. GET /api/download/:jobId/:format
 * Streams the generated SRT, VTT, or TXT subtitle file directly from Cloudflare R2.
 */
app.get('/api/download/:jobId/:format', async (c) => {
  const jobId = c.req.param('jobId');
  const format = c.req.param('format')?.toLowerCase();

  if (!['srt', 'vtt', 'txt'].includes(format)) {
    return c.json({ error: 'Unsupported format. Allowed formats: srt, vtt, txt' }, 400);
  }

  const job = await getJobById(c.env.DB, jobId);
  if (!job) {
    return c.json({ error: 'Job not found' }, 404);
  }

  if (job.status !== 'done') {
    return c.json(
      { error: `Job is not ready yet. Current status: ${job.status}` },
      400
    );
  }

  // Check direct object key in R2
  let objectKey =
    format === 'srt'
      ? job.srt_key
      : format === 'vtt'
      ? job.vtt_key
      : `subtitles/${job.video_id}/${job.language || 'und'}.txt`;

  let object = objectKey ? await c.env.BUCKET.get(objectKey) : null;

  // On-the-fly conversion fallback for TXT if not stored previously
  if (!object && format === 'txt') {
    const fallbackKey = job.srt_key || job.vtt_key;
    if (fallbackKey) {
      const fallbackObj = await c.env.BUCKET.get(fallbackKey);
      if (fallbackObj) {
        const text = await fallbackObj.text();
        const items = parseRawSubtitles(text);
        const plainText = convertToPlainText(items);
        return new Response(plainText, {
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': `attachment; filename="tiktok_${job.video_id}.txt"`,
          },
        });
      }
    }
  }

  if (!object) {
    return c.json({ error: 'Subtitle file not found in storage' }, 404);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set(
    'Content-Type',
    format === 'vtt' ? 'text/vtt; charset=utf-8' : 'text/plain; charset=utf-8'
  );
  headers.set(
    'Content-Disposition',
    `attachment; filename="tiktok_${job.video_id}.${format}"`
  );

  return new Response(object.body, { headers });
});

/**
 * 4. POST /api/convert-subtitle
 * Fetches and converts an alternate language subtitle directly on-demand.
 */
app.post('/api/convert-subtitle', async (c) => {
  try {
    const body = await c.req.json<{ url?: string }>().catch(() => ({ url: undefined }));
    const url = body?.url;

    if (!url || typeof url !== 'string' || !url.startsWith('http')) {
      return c.json({ error: 'Invalid or missing subtitle url' }, 400);
    }

    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Referer': 'https://www.tiktok.com/',
        'Accept': '*/*',
      },
      signal: AbortSignal.timeout(4000),
    });

    if (!res.ok) {
      return c.json({ error: `Failed to download subtitle file (HTTP ${res.status})` }, 502);
    }

    const raw = await res.text();
    const subtitles = parseRawSubtitles(raw);
    const transcript = convertToPlainText(subtitles);

    return c.json({
      success: true,
      subtitles,
      transcript,
      captionCount: subtitles.length,
      srt: convertToSrt(subtitles),
      vtt: convertToVtt(subtitles),
    });
  } catch (err: any) {
    return c.json({ error: err?.message || 'Failed to convert subtitle' }, 500);
  }
});

/**
 * 5. GET /api/v1/subtitles
 * Public Developer REST API:
 * - url: TikTok video URL (required)
 * - format: 'json' | 'srt' | 'vtt' | 'txt' (optional, default: 'json')
 * Rate limited to 30 requests/min/IP.
 * Executes Tier 1 & Tier 2 only (NO Browser Rendering Queue fallback).
 */
app.get('/api/v1/subtitles', async (c) => {
  try {
    const inputUrl = c.req.query('url')?.trim();
    const formatParam = (c.req.query('format')?.toLowerCase().trim() || 'json');

    if (!inputUrl) {
      return c.json({ error: 'Missing required query parameter "url"' }, 400);
    }

    if (!['json', 'srt', 'vtt', 'txt'].includes(formatParam)) {
      return c.json({ error: 'Invalid format. Allowed values: json, srt, vtt, txt' }, 400);
    }

    // Rate Limiting: 30 requests per minute per IP
    const clientIp = getClientIp(c.req.raw.headers);
    const rateLimit = await checkRateLimit(c.env.KV_CACHE, clientIp, 30, 60, 'ratelimit:api_v1');

    c.header('X-RateLimit-Limit', rateLimit.limit.toString());
    c.header('X-RateLimit-Remaining', rateLimit.remaining.toString());

    if (!rateLimit.allowed) {
      return c.json(
        {
          error: 'Rate limit exceeded. Maximum 30 requests per minute.',
          resetSeconds: rateLimit.resetSeconds,
        },
        429
      );
    }

    // Resolve URL & extract video ID
    let resolved;
    try {
      resolved = await resolveTikTokUrl(inputUrl);
    } catch (err: any) {
      return c.json(
        {
          error: 'Invalid TikTok URL or could not extract video ID',
          details: err?.message,
        },
        400
      );
    }

    const { videoId, resolvedUrl } = resolved;

    let subtitles: SubtitleItem[] = [];
    let detectedLanguage = 'und';
    let availableLanguages: AvailableLanguage[] = [];
    let transcript = '';
    let jobId: string = crypto.randomUUID();

    // 1. Check KV Cache
    const kvCached = (await c.env.KV_CACHE.get(`cache:video:${videoId}`, {
      type: 'json',
    })) as any;

    if (kvCached && kvCached.status === 'done') {
      jobId = kvCached.jobId || jobId;
      detectedLanguage = kvCached.language || 'und';
      availableLanguages = kvCached.availableLanguages || [];
      subtitles = kvCached.subtitles || [];
      transcript = kvCached.transcript || '';

      if (subtitles.length === 0 && (kvCached.srtKey || kvCached.vttKey)) {
        const obj = await c.env.BUCKET.get(kvCached.srtKey || kvCached.vttKey);
        if (obj) {
          const rawText = await obj.text();
          subtitles = parseRawSubtitles(rawText);
          transcript = convertToPlainText(subtitles);
        }
      }
    }

    // 2. Check D1 Database if not in KV
    if (subtitles.length === 0) {
      const existingJob = await getLatestJobByVideoId(c.env.DB, videoId);
      if (existingJob && existingJob.status === 'done') {
        jobId = existingJob.id;
        detectedLanguage = existingJob.language || 'und';
        const key = existingJob.srt_key || existingJob.vtt_key;
        if (key) {
          const obj = await c.env.BUCKET.get(key);
          if (obj) {
            const rawText = await obj.text();
            subtitles = parseRawSubtitles(rawText);
            transcript = convertToPlainText(subtitles);
          }
        }
      }
    }

    // 3. If still not in cache, execute Tier 1 & Tier 2 (Strictly NO Tier 3 Queue)
    if (subtitles.length === 0) {
      try {
        const t1 = await scrapeFastSubtitles(resolvedUrl, videoId, c.env.TIKTOK_COOKIE);
        if (t1.success && t1.subtitles && t1.subtitles.length > 0) {
          subtitles = t1.subtitles;
          detectedLanguage = t1.detectedLanguage || 'und';
          availableLanguages = t1.availableLanguages || [];
        }
      } catch (t1Err) {
        // Continue to Tier 2
      }

      if (subtitles.length === 0) {
        try {
          const t2 = await scrapeMirrorSubtitles(resolvedUrl, videoId);
          if (t2.success && t2.subtitles && t2.subtitles.length > 0) {
            subtitles = t2.subtitles;
            detectedLanguage = t2.detectedLanguage || 'und';
            availableLanguages = t2.availableLanguages || [];
          }
        } catch (t2Err) {
          // Ignore
        }
      }

      if (subtitles.length === 0) {
        return c.json(
          {
            error: 'No subtitles available or extraction failed for this video.',
            videoId,
            status: 'no_subtitles_available',
          },
          404
        );
      }

      const persisted = await persistSubtitles(
        c.env,
        jobId,
        videoId,
        detectedLanguage,
        subtitles,
        availableLanguages
      );
      transcript = persisted.transcript;
    }

    if (!transcript && subtitles.length > 0) {
      transcript = convertToPlainText(subtitles);
    }

    // 4. Format delivery
    if (formatParam === 'srt') {
      const srtText = convertToSrt(subtitles);
      return new Response(srtText, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `inline; filename="tiktok_${videoId}.srt"`,
        },
      });
    }

    if (formatParam === 'vtt') {
      const vttText = convertToVtt(subtitles);
      return new Response(vttText, {
        headers: {
          'Content-Type': 'text/vtt; charset=utf-8',
          'Content-Disposition': `inline; filename="tiktok_${videoId}.vtt"`,
        },
      });
    }

    if (formatParam === 'txt') {
      return new Response(transcript, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `inline; filename="tiktok_${videoId}.txt"`,
        },
      });
    }

    // Default: JSON response
    return c.json({
      success: true,
      videoId,
      language: detectedLanguage,
      captionCount: subtitles.length,
      transcript,
      subtitles,
      languages: availableLanguages,
      downloads: {
        srt: `/api/download/${jobId}/srt`,
        vtt: `/api/download/${jobId}/vtt`,
        txt: `/api/download/${jobId}/txt`,
      },
    });
  } catch (err: any) {
    return c.json({ error: 'Internal server error processing API request', details: err?.message }, 500);
  }
});

interface FeedbackRequestBody {
  message?: string;
  optionalContact?: string;
  turnstileToken?: string;
  'cf-turnstile-response'?: string;
}

/**
 * 4. POST /api/feedback
 * Receives user feedback, validates length & bot protection, and forwards to Discord Webhook.
 */
app.post('/api/feedback', async (c) => {
  try {
    const body: FeedbackRequestBody = await c.req.json<FeedbackRequestBody>().catch(() => ({} as FeedbackRequestBody));

    const rawMessage = typeof body?.message === 'string' ? body.message.trim() : '';
    const optionalContact =
      typeof body?.optionalContact === 'string' && body.optionalContact.trim()
        ? body.optionalContact.trim()
        : undefined;

    const turnstileToken =
      typeof body?.['cf-turnstile-response'] === 'string'
        ? body['cf-turnstile-response']
        : typeof body?.turnstileToken === 'string'
        ? body.turnstileToken
        : undefined;

    // Validation: message length (min 5, max 1500 chars)
    if (!rawMessage || rawMessage.length < 5) {
      return c.json({ error: 'Feedback message must be at least 5 characters long' }, 400);
    }

    if (rawMessage.length > 1500) {
      return c.json({ error: 'Feedback message must not exceed 1500 characters' }, 400);
    }

    // Rate-Limiting: Max 3 feedback requests per IP per 15 minutes (900 seconds)
    const clientIp = getClientIp(c.req.raw.headers);
    const rateLimit = await checkRateLimit(c.env.KV_CACHE, clientIp, 3, 900, 'ratelimit:feedback');

    c.header('X-RateLimit-Limit', rateLimit.limit.toString());
    c.header('X-RateLimit-Remaining', rateLimit.remaining.toString());

    if (!rateLimit.allowed) {
      return c.json(
        {
          error: 'Feedback rate limit exceeded. Maximum 3 messages per 15 minutes.',
          resetSeconds: rateLimit.resetSeconds,
        },
        429
      );
    }

    // Turnstile Bot Protection
    const turnstileResult = await verifyTurnstileToken(
      turnstileToken,
      clientIp,
      c.env.TURNSTILE_SECRET_KEY
    );

    if (!turnstileResult.success) {
      return c.json(
        {
          error: 'Bot verification failed',
          details: turnstileResult.error,
        },
        403
      );
    }

    // Send formatted embed to Discord Webhook
    if (c.env.DISCORD_WEBHOOK_URL) {
      const discordPayload = {
        embeds: [
          {
            title: '📬 Neues Nutzer-Feedback (TikTok Caption Extractor)',
            color: 5793266,
            fields: [
              { name: 'Nachricht', value: rawMessage },
              { name: 'Kontakt (optional)', value: optionalContact || 'Keine Angabe' },
            ],
            timestamp: new Date().toISOString(),
          },
        ],
      };

      try {
        const discordRes = await fetch(c.env.DISCORD_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(discordPayload),
          signal: AbortSignal.timeout(5000),
        });

        if (!discordRes.ok) {
          console.error(`[Feedback] Discord webhook returned HTTP ${discordRes.status}`);
        }
      } catch (webhookErr: any) {
        console.error('[Feedback] Failed to send Discord webhook:', webhookErr?.message);
      }
    } else {
      console.warn('[Feedback] DISCORD_WEBHOOK_URL not configured. Feedback logged:', rawMessage);
    }

    return c.json({ success: true, message: 'Feedback successfully sent' });
  } catch (err: any) {
    return c.json({ error: 'Internal server error while processing feedback', details: err?.message }, 500);
  }
});

/**
 * Google Search Console Site Verification Endpoints
 */
app.get('/googlec2cc10a2757e015f.html', (c) => {
  return c.text('google-site-verification: googlec2cc10a2757e015f.html', 200, {
    'Content-Type': 'text/html; charset=utf-8',
  });
});

app.get('/googlec2cc10a2757e015f', (c) => {
  return c.text('google-site-verification: googlec2cc10a2757e015f.html', 200, {
    'Content-Type': 'text/html; charset=utf-8',
  });
});

/**
 * Cloudflare Worker Export:
 * Includes both Hono HTTP router (fetch) and Cloudflare Queue consumer (queue).
 */
export default {
  fetch: app.fetch,

  /**
   * Queue Consumer (Tier 3 Ultimate Fallback)
   * Runs Puppeteer with max_concurrency = 2.
   */
  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      const { jobId, videoId, resolvedUrl } = msg.body;

      try {
        await updateJobStatus(env.DB, jobId, 'processing');

        // Scrape subtitles using Cloudflare Browser Rendering
        const result = await scrapeTikTokCaptions(env, videoId, resolvedUrl);

        if (result.success && result.subtitles && result.subtitles.length > 0) {
          await persistSubtitles(
            env,
            jobId,
            videoId,
            result.detectedLanguage || 'und',
            result.subtitles,
            result.availableLanguages
          );
          msg.ack();
          continue;
        }

        // Handle Terminal Failures (Do NOT retry, fail-fast and ack)
        const terminalStatuses = [
          'no_subtitles_available',
          'video_private_or_deleted',
          'failed_blocked',
          'invalid_link',
        ];

        if (terminalStatuses.includes(result.status)) {
          await updateJobStatus(env.DB, jobId, result.status, {
            errorMessage: result.error || 'Terminal extraction failure',
          });
          msg.ack();
          continue;
        }

        // If status is a transient 'error', use native Cloudflare Queue retry
        if (msg.attempts < 3) {
          const backoffSeconds = Math.pow(2, msg.attempts) * 15;
          console.warn(`Transient error on job ${jobId}, retrying in ${backoffSeconds}s...`);
          msg.retry({ delaySeconds: backoffSeconds });
        } else {
          await updateJobStatus(env.DB, jobId, 'error', {
            errorMessage: result.error || 'Max queue retries reached',
          });
          msg.ack();
        }
      } catch (err: any) {
        console.error(`Fatal unexpected error processing job ${jobId}:`, err);

        if (msg.attempts < 3) {
          msg.retry({ delaySeconds: 30 });
        } else {
          await updateJobStatus(env.DB, jobId, 'error', {
            errorMessage: err?.message || 'Fatal queue processing error',
          });
          msg.ack();
        }
      }
    }
  },
};
