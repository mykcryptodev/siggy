import { bot } from '../bot/index.js';
import { formatNotificationMessage } from './templates.js';
import { getMonitoredSafeLabel } from '../db/queries.js';
import type { communities, safeTransactions } from '../db/schema.js';
import type { NotificationType } from '../db/schema.js';

type Community = typeof communities.$inferSelect;
type SafeTx = typeof safeTransactions.$inferSelect;

interface SendNotificationParams {
  community: Community;
  safeTx: SafeTx;
  notificationType: NotificationType;
  safeAddress: string;
  chainId: number;
}

const TELEGRAM_RATE_LIMIT_MS = 1100; // 1.1s between messages per chat to stay under 1/s limit
const lastSendTime = new Map<string, number>();

async function rateLimit(chatId: bigint): Promise<void> {
  const key = chatId.toString();
  const last = lastSendTime.get(key) ?? 0;
  const now = Date.now();
  const elapsed = now - last;

  if (elapsed < TELEGRAM_RATE_LIMIT_MS) {
    const waitMs = TELEGRAM_RATE_LIMIT_MS - elapsed;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  lastSendTime.set(key, Date.now());
}

/**
 * Send a notification to a Telegram chat.
 * Returns the Telegram message ID on success.
 */
export async function sendNotification(params: SendNotificationParams): Promise<number | null> {
  const { community, safeTx, notificationType, safeAddress, chainId } = params;

  // Fetch the label for this Safe in this community
  const label = await getMonitoredSafeLabel(community.id, safeAddress, chainId);

  const message = formatNotificationMessage({
    tx: safeTx,
    safeAddress,
    chainId,
    label,
    notificationType,
  });

  // Rate-limit per chat
  await rateLimit(community.telegramChatId);

  const MAX_RETRIES = 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await bot.api.sendMessage(community.telegramChatId.toString(), message, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
      return result.message_id;
    } catch (err) {
      lastError = err;

      // Check for Telegram rate limit error (429)
      const errObj = err as { error_code?: number; parameters?: { retry_after?: number } };
      if (errObj?.error_code === 429) {
        const retryAfter = errObj?.parameters?.retry_after ?? 30;
        console.warn(
          `[notifier] Rate limited by Telegram for chat ${community.telegramChatId}, ` +
          `waiting ${retryAfter}s before retry ${attempt}/${MAX_RETRIES}`,
        );
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        continue;
      }

      // Bot was kicked or chat doesn't exist — don't retry
      if (errObj?.error_code === 403 || errObj?.error_code === 400) {
        console.error(
          `[notifier] Cannot send to chat ${community.telegramChatId} (error ${errObj.error_code}):`,
          err,
        );
        return null;
      }

      // Other errors — short wait and retry
      if (attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      }
    }
  }

  console.error(
    `[notifier] Failed to send notification after ${MAX_RETRIES} attempts for chat ${community.telegramChatId}:`,
    lastError,
  );
  return null;
}
