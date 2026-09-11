// Cloudflare Environment & Domain Type Definitions

export type JobStatus =
  | 'queued'
  | 'processing'
  | 'done'
  | 'failed_blocked'
  | 'no_subtitles_available'
  | 'video_private_or_deleted'
  | 'invalid_link'
  | 'error';

export type ScrapeTier = 'cache' | 'tier1_fast' | 'tier2_mirror' | 'tier3_browser';

export interface Env {
  // Cloudflare Bindings
  MYBROWSER: any; // Cloudflare Browser Rendering binding (Puppeteer endpoint)
  DB: D1Database;
  BUCKET: R2Bucket;
  KV_CACHE: KVNamespace;
  QUEUE: Queue<QueueMessage>;
  ASSETS?: Fetcher;

  // Environment variables & secrets
  ENVIRONMENT?: string;
  MAX_REQUESTS_PER_MINUTE?: string;
  TIKTOK_COOKIE?: string; // Optional custom cookie secret for high-volume bypass if configured
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
  DISCORD_WEBHOOK_URL?: string;
}

export interface CaptionJob {
  id: string;
  video_id: string;
  source_url: string;
  resolved_url: string | null;
  status: JobStatus;
  error_message: string | null;
  language: string | null;
  srt_key: string | null;
  vtt_key: string | null;
  caption_count: number;
  created_at: number;
  updated_at: number;
}

export interface QueueMessage {
  jobId: string;
  videoId: string;
  resolvedUrl: string;
  sourceUrl: string;
  retryCount?: number;
}

export interface SubtitleItem {
  start: number; // milliseconds
  end: number;   // milliseconds
  text: string;
}

export interface ExtractedSubtitleInfo {
  id?: string;
  language: string;
  languageCode: string;
  format: string; // 'webvtt' | 'json' | 'ttml' | string
  url: string;
  isOriginal?: boolean;
}

export interface AvailableLanguage {
  code: string;
  name: string;
  isOriginal?: boolean;
  url?: string;
}

export interface ScrapeResult {
  success: boolean;
  status: JobStatus;
  error?: string;
  detectedLanguage?: string;
  subtitles?: SubtitleItem[];
  availableLanguages?: AvailableLanguage[];
}

export interface CachedVideoResult {
  jobId: string;
  videoId: string;
  status: JobStatus;
  language?: string;
  srtKey?: string;
  vttKey?: string;
  txtKey?: string;
  captionCount?: number;
  availableLanguages?: AvailableLanguage[];
  transcript?: string;
  timestamp: number;
}
