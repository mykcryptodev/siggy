import type { VercelRequest, VercelResponse } from '@vercel/node';
import { runPoll } from '../src/poller/index.js';

/**
 * Vercel Cron endpoint — called every 60 seconds by Vercel Cron.
 * Polls all monitored Safes and sends notifications for new transactions.
 *
 * This endpoint should be protected from public access.
 * Vercel Cron automatically adds a `Authorization: Bearer <CRON_SECRET>` header.
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  // Allow GET (cron) and POST (manual trigger)
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Protect against unauthorized access
  // Vercel Cron sends the CRON_SECRET in Authorization header
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${cronSecret}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
  }

  const startTime = Date.now();

  try {
    const { results, totalNotifications } = await runPoll();

    const elapsed = Date.now() - startTime;
    const errors = results.filter((r) => r.error);

    console.log(
      `[poll] Completed in ${elapsed}ms — ` +
      `${results.length} Safes processed, ` +
      `${totalNotifications} notifications sent, ` +
      `${errors.length} errors`,
    );

    if (errors.length > 0) {
      for (const e of errors) {
        console.error(`[poll] Error for ${e.safeAddress} (chain ${e.chainId}): ${e.error}`);
      }
    }

    res.status(200).json({
      ok: true,
      safesProcessed: results.length,
      notificationsSent: totalNotifications,
      errors: errors.length,
      elapsedMs: elapsed,
    });
  } catch (err) {
    const elapsed = Date.now() - startTime;
    console.error('[poll] Fatal error:', err);

    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : 'Unknown error',
      elapsedMs: elapsed,
    });
  }
}
