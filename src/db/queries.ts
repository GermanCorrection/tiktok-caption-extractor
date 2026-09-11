import { CaptionJob, JobStatus } from '../types';

export async function createJob(
  db: D1Database,
  job: {
    id: string;
    videoId: string;
    sourceUrl: string;
    resolvedUrl?: string | null;
    status: JobStatus;
  }
): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO caption_jobs (
        id, video_id, source_url, resolved_url, status, error_message,
        language, srt_key, vtt_key, caption_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 0, ?, ?)`
    )
    .bind(
      job.id,
      job.videoId,
      job.sourceUrl,
      job.resolvedUrl ?? null,
      job.status,
      now,
      now
    )
    .run();
}

export async function getJobById(
  db: D1Database,
  id: string
): Promise<CaptionJob | null> {
  const row = await db
    .prepare('SELECT * FROM caption_jobs WHERE id = ?')
    .bind(id)
    .first<CaptionJob>();
  return row ?? null;
}

export async function getLatestJobByVideoId(
  db: D1Database,
  videoId: string
): Promise<CaptionJob | null> {
  const row = await db
    .prepare(
      'SELECT * FROM caption_jobs WHERE video_id = ? ORDER BY created_at DESC LIMIT 1'
    )
    .bind(videoId)
    .first<CaptionJob>();
  return row ?? null;
}

export async function updateJobStatus(
  db: D1Database,
  id: string,
  status: JobStatus,
  updates?: {
    errorMessage?: string | null;
    language?: string | null;
    srtKey?: string | null;
    vttKey?: string | null;
    captionCount?: number;
    resolvedUrl?: string | null;
  }
): Promise<void> {
  const now = Date.now();
  const fields: string[] = ['status = ?', 'updated_at = ?'];
  const values: any[] = [status, now];

  if (updates?.errorMessage !== undefined) {
    fields.push('error_message = ?');
    values.push(updates.errorMessage);
  }
  if (updates?.language !== undefined) {
    fields.push('language = ?');
    values.push(updates.language);
  }
  if (updates?.srtKey !== undefined) {
    fields.push('srt_key = ?');
    values.push(updates.srtKey);
  }
  if (updates?.vttKey !== undefined) {
    fields.push('vtt_key = ?');
    values.push(updates.vttKey);
  }
  if (updates?.captionCount !== undefined) {
    fields.push('caption_count = ?');
    values.push(updates.captionCount);
  }
  if (updates?.resolvedUrl !== undefined) {
    fields.push('resolved_url = ?');
    values.push(updates.resolvedUrl);
  }

  values.push(id);

  const query = `UPDATE caption_jobs SET ${fields.join(', ')} WHERE id = ?`;
  await db.prepare(query).bind(...values).run();
}
