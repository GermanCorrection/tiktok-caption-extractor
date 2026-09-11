-- D1 Database Schema for TikTok Caption Extractor

CREATE TABLE IF NOT EXISTS caption_jobs (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL,
    source_url TEXT NOT NULL,
    resolved_url TEXT,
    status TEXT NOT NULL, -- 'queued', 'processing', 'done', 'failed_blocked', 'no_subtitles_available', 'video_private_or_deleted', 'invalid_link', 'error'
    error_message TEXT,
    language TEXT,
    srt_key TEXT,
    vtt_key TEXT,
    caption_count INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_caption_jobs_video_id ON caption_jobs(video_id);
CREATE INDEX IF NOT EXISTS idx_caption_jobs_status ON caption_jobs(status);
CREATE INDEX IF NOT EXISTS idx_caption_jobs_created_at ON caption_jobs(created_at);
