import { eq, and, inArray, sql } from 'drizzle-orm';
import { db } from './index.js';
import {
  communities,
  monitoredSafes,
  safeTransactions,
  notificationsSent,
  type TxStatus,
  type NotificationType,
  type DecodedSummaryJson,
  type TxType,
} from './schema.js';

// ──────────────────────────────────────────────
// Community queries
// ──────────────────────────────────────────────

export async function upsertCommunity(params: {
  telegramChatId: bigint;
  chatType: string;
  chatTitle: string | null;
  adminUserIds: string[];
}): Promise<typeof communities.$inferSelect> {
  const [result] = await db
    .insert(communities)
    .values({
      telegramChatId: params.telegramChatId,
      chatType: params.chatType,
      chatTitle: params.chatTitle,
      adminUserIds: params.adminUserIds,
      isActive: true,
    })
    .onConflictDoUpdate({
      target: communities.telegramChatId,
      set: {
        chatType: params.chatType,
        chatTitle: params.chatTitle,
        adminUserIds: params.adminUserIds,
        isActive: true,
      },
    })
    .returning();
  return result;
}

export async function getCommunityByChatId(
  telegramChatId: bigint,
): Promise<typeof communities.$inferSelect | null> {
  const [result] = await db
    .select()
    .from(communities)
    .where(eq(communities.telegramChatId, telegramChatId))
    .limit(1);
  return result ?? null;
}

export async function updateCommunityAdmins(
  telegramChatId: bigint,
  adminUserIds: string[],
): Promise<void> {
  await db
    .update(communities)
    .set({ adminUserIds })
    .where(eq(communities.telegramChatId, telegramChatId));
}

export async function deactivateCommunity(telegramChatId: bigint): Promise<void> {
  await db
    .update(communities)
    .set({ isActive: false })
    .where(eq(communities.telegramChatId, telegramChatId));
}

// ──────────────────────────────────────────────
// Monitored safes queries
// ──────────────────────────────────────────────

export async function addMonitoredSafe(params: {
  communityId: number;
  safeAddress: string;
  chainId: number;
  label: string | null;
  addedBy: bigint;
}): Promise<typeof monitoredSafes.$inferSelect> {
  const [result] = await db
    .insert(monitoredSafes)
    .values({
      communityId: params.communityId,
      safeAddress: params.safeAddress.toLowerCase(),
      chainId: params.chainId,
      label: params.label,
      addedBy: params.addedBy,
    })
    .onConflictDoUpdate({
      target: [
        monitoredSafes.communityId,
        monitoredSafes.safeAddress,
        monitoredSafes.chainId,
      ],
      set: {
        label: params.label,
      },
    })
    .returning();
  return result;
}

export async function removeMonitoredSafe(params: {
  communityId: number;
  safeAddress: string;
  chainId?: number;
}): Promise<void> {
  if (params.chainId !== undefined) {
    await db
      .delete(monitoredSafes)
      .where(
        and(
          eq(monitoredSafes.communityId, params.communityId),
          eq(monitoredSafes.safeAddress, params.safeAddress.toLowerCase()),
          eq(monitoredSafes.chainId, params.chainId),
        ),
      );
  } else {
    await db
      .delete(monitoredSafes)
      .where(
        and(
          eq(monitoredSafes.communityId, params.communityId),
          eq(monitoredSafes.safeAddress, params.safeAddress.toLowerCase()),
        ),
      );
  }
}

export async function getMonitoredSafesForCommunity(
  communityId: number,
): Promise<(typeof monitoredSafes.$inferSelect)[]> {
  return db
    .select()
    .from(monitoredSafes)
    .where(eq(monitoredSafes.communityId, communityId));
}

export async function getAllDistinctMonitoredSafes(): Promise<
  Array<{ safeAddress: string; chainId: number }>
> {
  const results = await db
    .selectDistinct({
      safeAddress: monitoredSafes.safeAddress,
      chainId: monitoredSafes.chainId,
    })
    .from(monitoredSafes)
    .innerJoin(communities, eq(monitoredSafes.communityId, communities.id))
    .where(eq(communities.isActive, true));
  return results;
}

export async function getCommunitiesForSafe(
  safeAddress: string,
  chainId: number,
): Promise<(typeof communities.$inferSelect)[]> {
  return db
    .select({ communities })
    .from(communities)
    .innerJoin(monitoredSafes, eq(monitoredSafes.communityId, communities.id))
    .where(
      and(
        eq(monitoredSafes.safeAddress, safeAddress.toLowerCase()),
        eq(monitoredSafes.chainId, chainId),
        eq(communities.isActive, true),
      ),
    )
    .then((rows) => rows.map((r) => r.communities));
}

export async function getMonitoredSafeLabel(
  communityId: number,
  safeAddress: string,
  chainId: number,
): Promise<string | null> {
  const [row] = await db
    .select({ label: monitoredSafes.label })
    .from(monitoredSafes)
    .where(
      and(
        eq(monitoredSafes.communityId, communityId),
        eq(monitoredSafes.safeAddress, safeAddress.toLowerCase()),
        eq(monitoredSafes.chainId, chainId),
      ),
    )
    .limit(1);
  return row?.label ?? null;
}

// ──────────────────────────────────────────────
// Safe transactions queries
// ──────────────────────────────────────────────

export async function upsertSafeTransaction(params: {
  safeAddress: string;
  chainId: number;
  safeTxHash: string;
  nonce: number | null;
  status: TxStatus;
  txType: TxType | null;
  toAddress: string | null;
  valueWei: string | null;
  calldata: string | null;
  decodedSummary: DecodedSummaryJson | null;
  onChainHash: string | null;
  confirmationCount: number;
  requiredConfirmations: number | null;
  rawPayload: Record<string, unknown>;
}): Promise<typeof safeTransactions.$inferSelect> {
  const [result] = await db
    .insert(safeTransactions)
    .values({
      safeAddress: params.safeAddress.toLowerCase(),
      chainId: params.chainId,
      safeTxHash: params.safeTxHash,
      nonce: params.nonce,
      status: params.status,
      txType: params.txType ?? undefined,
      toAddress: params.toAddress,
      valueWei: params.valueWei,
      calldata: params.calldata,
      decodedSummary: params.decodedSummary,
      onChainHash: params.onChainHash,
      confirmationCount: params.confirmationCount,
      requiredConfirmations: params.requiredConfirmations,
      rawPayload: params.rawPayload,
      lastUpdatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [safeTransactions.safeTxHash, safeTransactions.chainId],
      set: {
        status: params.status,
        confirmationCount: params.confirmationCount,
        onChainHash: params.onChainHash,
        decodedSummary: params.decodedSummary,
        lastUpdatedAt: new Date(),
      },
    })
    .returning();
  return result;
}

export async function getSafeTransaction(
  safeTxHash: string,
  chainId: number,
): Promise<typeof safeTransactions.$inferSelect | null> {
  const [result] = await db
    .select()
    .from(safeTransactions)
    .where(
      and(
        eq(safeTransactions.safeTxHash, safeTxHash),
        eq(safeTransactions.chainId, chainId),
      ),
    )
    .limit(1);
  return result ?? null;
}

export async function getExistingTxHashesForSafe(
  safeAddress: string,
  chainId: number,
): Promise<string[]> {
  const results = await db
    .select({ safeTxHash: safeTransactions.safeTxHash })
    .from(safeTransactions)
    .where(
      and(
        eq(safeTransactions.safeAddress, safeAddress.toLowerCase()),
        eq(safeTransactions.chainId, chainId),
      ),
    );
  return results.map((r) => r.safeTxHash);
}

export async function bulkInsertWatermarkedTxHashes(
  safeAddress: string,
  chainId: number,
  hashes: string[],
): Promise<void> {
  if (hashes.length === 0) return;

  const values = hashes.map((h) => ({
    safeAddress: safeAddress.toLowerCase(),
    chainId,
    safeTxHash: h,
    nonce: null,
    status: 'watermarked' as TxStatus,
    txType: null,
    toAddress: null,
    valueWei: null,
    calldata: null,
    decodedSummary: null,
    onChainHash: null,
    confirmationCount: 0,
    requiredConfirmations: null,
    rawPayload: {},
  }));

  // Insert in batches to avoid hitting parameter limits
  const BATCH_SIZE = 100;
  for (let i = 0; i < values.length; i += BATCH_SIZE) {
    const batch = values.slice(i, i + BATCH_SIZE);
    await db
      .insert(safeTransactions)
      .values(batch)
      .onConflictDoNothing();
  }
}

// ──────────────────────────────────────────────
// Notifications queries
// ──────────────────────────────────────────────

export async function wasNotificationSent(
  safeTxId: number,
  communityId: number,
  notificationType: NotificationType,
): Promise<boolean> {
  const [result] = await db
    .select({ id: notificationsSent.id })
    .from(notificationsSent)
    .where(
      and(
        eq(notificationsSent.safeTxId, safeTxId),
        eq(notificationsSent.communityId, communityId),
        eq(notificationsSent.notificationType, notificationType),
      ),
    )
    .limit(1);
  return !!result;
}

export async function recordNotificationSent(params: {
  safeTxId: number;
  communityId: number;
  notificationType: NotificationType;
  telegramMessageId: number | null;
}): Promise<void> {
  await db
    .insert(notificationsSent)
    .values({
      safeTxId: params.safeTxId,
      communityId: params.communityId,
      notificationType: params.notificationType,
      telegramMessageId: params.telegramMessageId,
    })
    .onConflictDoNothing();
}

// ──────────────────────────────────────────────
// Stats / status queries
// ──────────────────────────────────────────────

export async function countMonitoredSafes(): Promise<number> {
  const [result] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(monitoredSafes);
  return result?.count ?? 0;
}

export async function countActiveCommunities(): Promise<number> {
  const [result] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(communities)
    .where(eq(communities.isActive, true));
  return result?.count ?? 0;
}
