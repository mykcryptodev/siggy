import type { VercelRequest, VercelResponse } from '@vercel/node';
import { webhookCallback } from 'grammy';
import { bot } from '../src/bot/index.js';

// Grammy webhook handler for Vercel
// Telegram will POST updates to this endpoint
const handleUpdate = webhookCallback(bot, 'std/http');

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Optional: verify webhook secret header for security
  const webhookSecret = process.env.WEBHOOK_SECRET;
  if (webhookSecret) {
    const tokenHeader = req.headers['x-telegram-bot-api-secret-token'];
    if (tokenHeader !== webhookSecret) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
  }

  try {
    // Grammy's webhookCallback expects a Request object (Web API)
    // Vercel provides req/res — we need to bridge them
    const body = JSON.stringify(req.body);

    const request = new Request('https://localhost/api/telegram', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body,
    });

    const response = await handleUpdate(request);
    const responseBody = await response.text();

    res
      .status(response.status)
      .setHeader('content-type', response.headers.get('content-type') ?? 'application/json')
      .send(responseBody || 'OK');
  } catch (err) {
    // Never let errors reach Telegram — always return 200 to prevent retries
    console.error('[webhook] Error handling update:', err);
    res.status(200).json({ ok: true });
  }
}
