import { fetchMultisigTransactions, getTxStatus, SafeFetchError } from './fetcher.js';
import { decodeTx } from '../decoder/index.js';
import {
  getAllDistinctMonitoredSafes,
  getExistingTxHashesForSafe,
  upsertSafeTransaction,
  getSafeTransaction,
  getCommunitiesForSafe,
  wasNotificationSent,
  recordNotificationSent,
} from '../db/queries.js';
import { sendNotification } from '../notifier/index.js';
import type { TxStatus, TxType } from '../db/schema.js';

const POLL_BATCH_SIZE = 50; // Max safes to process in one invocation

interface PollResult {
  safeAddress: string;
  chainId: number;
  txsProcessed: number;
  notificationsSent: number;
  error?: string;
}

/**
 * Main poll function — called by /api/poll (Vercel Cron)
 * Processes all monitored Safes, detects new/changed transactions,
 * and dispatches notifications.
 */
export async function runPoll(): Promise<{ results: PollResult[]; totalNotifications: number }> {
  const allSafes = await getAllDistinctMonitoredSafes();
  const results: PollResult[] = [];
  let totalNotifications = 0;

  // Process in batches to avoid timeout on large deployments
  const batch = allSafes.slice(0, POLL_BATCH_SIZE);

  // Process all safes concurrently (with some parallelism limit)
  const CONCURRENCY = 5;
  for (let i = 0; i < batch.length; i += CONCURRENCY) {
    const chunk = batch.slice(i, i + CONCURRENCY);
    const chunkResults = await Promise.all(
      chunk.map(({ safeAddress, chainId }) => pollOneSafe(safeAddress, chainId)),
    );
    for (const r of chunkResults) {
      results.push(r);
      totalNotifications += r.notificationsSent;
    }
  }

  return { results, totalNotifications };
}

async function pollOneSafe(safeAddress: string, chainId: number): Promise<PollResult> {
  const result: PollResult = {
    safeAddress,
    chainId,
    txsProcessed: 0,
    notificationsSent: 0,
  };

  try {
    const txs = await fetchMultisigTransactions(safeAddress, chainId, 20);

    // Get existing known hashes to detect new ones
    const existingHashes = new Set(await getExistingTxHashesForSafe(safeAddress, chainId));

    for (const tx of txs) {
      const currentStatus = getTxStatus(tx);
      const isNew = !existingHashes.has(tx.safeTxHash);

      // Decode calldata
      let decoded = null;
      try {
        decoded = await decodeTx({
          to: tx.to,
          value: tx.value,
          data: tx.data,
          chainId,
        });
      } catch (err) {
        console.error(`[poller] Decode error for ${tx.safeTxHash}:`, err);
      }

      const txType = decoded?.type as TxType | null;

      // Upsert into DB
      const dbTx = await upsertSafeTransaction({
        safeAddress,
        chainId,
        safeTxHash: tx.safeTxHash,
        nonce: tx.nonce,
        status: currentStatus,
        txType: txType ?? null,
        toAddress: tx.to,
        valueWei: tx.value,
        calldata: tx.data,
        decodedSummary: decoded,
        onChainHash: tx.transactionHash,
        confirmationCount: tx.confirmations?.length ?? 0,
        requiredConfirmations: tx.confirmationsRequired,
        rawPayload: tx as unknown as Record<string, unknown>,
      });

      result.txsProcessed++;

      // Skip watermarked — never notify
      if (dbTx.status === 'watermarked') continue;

      // Determine which notification type to send
      const notifType = statusToNotifType(currentStatus);
      if (!notifType) continue;

      // Fan out to all communities watching this Safe
      const communities = await getCommunitiesForSafe(safeAddress, chainId);

      for (const community of communities) {
        // Check dedup
        const alreadySent = await wasNotificationSent(dbTx.id, community.id, notifType);
        if (alreadySent) continue;

        // Send the notification
        try {
          const msgId = await sendNotification({
            community,
            safeTx: dbTx,
            notificationType: notifType,
            safeAddress,
            chainId,
          });

          await recordNotificationSent({
            safeTxId: dbTx.id,
            communityId: community.id,
            notificationType: notifType,
            telegramMessageId: msgId,
          });

          result.notificationsSent++;
        } catch (err) {
          console.error(
            `[poller] Failed to send notification for ${tx.safeTxHash} to chat ${community.telegramChatId}:`,
            err,
          );
        }
      }
    }
  } catch (err) {
    if (err instanceof SafeFetchError) {
      result.error = err.message;
      if (!err.retryable) {
        console.error(`[poller] Non-retryable error for ${safeAddress} (chain ${chainId}):`, err.message);
      }
    } else {
      const message = err instanceof Error ? err.message : 'Unknown error';
      result.error = message;
      console.error(`[poller] Unexpected error for ${safeAddress} (chain ${chainId}):`, err);
    }
  }

  return result;
}

function statusToNotifType(status: TxStatus): 'pending' | 'executed' | 'cancelled' | null {
  switch (status) {
    case 'pending':
      return 'pending';
    case 'executed':
      return 'executed';
    case 'cancelled':
      return 'cancelled';
    default:
      return null;
  }
}
