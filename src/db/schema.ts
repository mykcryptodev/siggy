import {
  pgTable,
  serial,
  bigint,
  text,
  integer,
  boolean,
  timestamp,
  json,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// ──────────────────────────────────────────────
// communities
// ──────────────────────────────────────────────
export const communities = pgTable('communities', {
  id: serial('id').primaryKey(),
  telegramChatId: bigint('telegram_chat_id', { mode: 'bigint' }).notNull().unique(),
  chatType: text('chat_type').notNull(), // 'group' | 'supergroup' | 'channel' | 'private'
  chatTitle: text('chat_title'),
  adminUserIds: json('admin_user_ids').$type<string[]>().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  isActive: boolean('is_active').notNull().default(true),
});

// ──────────────────────────────────────────────
// monitored_safes
// ──────────────────────────────────────────────
export const monitoredSafes = pgTable(
  'monitored_safes',
  {
    id: serial('id').primaryKey(),
    communityId: integer('community_id')
      .notNull()
      .references(() => communities.id, { onDelete: 'cascade' }),
    safeAddress: text('safe_address').notNull(),
    chainId: integer('chain_id').notNull(),
    label: text('label'),
    addedBy: bigint('added_by', { mode: 'bigint' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueCommunityAddressChain: uniqueIndex('monitored_safes_unique').on(
      table.communityId,
      table.safeAddress,
      table.chainId,
    ),
  }),
);

// ──────────────────────────────────────────────
// safe_transactions
// ──────────────────────────────────────────────
export type TxStatus = 'pending' | 'executed' | 'cancelled' | 'watermarked';
export type TxType =
  | 'eth_transfer'
  | 'erc20_transfer'
  | 'erc20_approve'
  | 'contract_call'
  | 'multisend'
  | 'unknown';

export const safeTransactions = pgTable(
  'safe_transactions',
  {
    id: serial('id').primaryKey(),
    safeAddress: text('safe_address').notNull(),
    chainId: integer('chain_id').notNull(),
    safeTxHash: text('safe_tx_hash').notNull(),
    nonce: integer('nonce'),
    status: text('status').$type<TxStatus>().notNull(),
    txType: text('tx_type').$type<TxType>(),
    toAddress: text('to_address'),
    valueWei: text('value_wei'),
    calldata: text('calldata'),
    decodedSummary: json('decoded_summary').$type<DecodedSummaryJson | null>(),
    onChainHash: text('on_chain_hash'),
    confirmationCount: integer('confirmation_count').notNull().default(0),
    requiredConfirmations: integer('required_confirmations'),
    rawPayload: json('raw_payload'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastUpdatedAt: timestamp('last_updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueHashChain: uniqueIndex('safe_transactions_unique').on(table.safeTxHash, table.chainId),
  }),
);

export interface DecodedSummaryJson {
  type: TxType;
  summary: string;
  details?: string[];
  confidence: 'high' | 'medium' | 'low';
  warnings?: string[];
}

// ──────────────────────────────────────────────
// notifications_sent
// ──────────────────────────────────────────────
export type NotificationType = 'pending' | 'executed' | 'cancelled';

export const notificationsSent = pgTable(
  'notifications_sent',
  {
    id: serial('id').primaryKey(),
    safeTxId: integer('safe_tx_id')
      .notNull()
      .references(() => safeTransactions.id),
    communityId: integer('community_id')
      .notNull()
      .references(() => communities.id),
    notificationType: text('notification_type').$type<NotificationType>().notNull(),
    telegramMessageId: integer('telegram_message_id'),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueNotification: uniqueIndex('notifications_sent_unique').on(
      table.safeTxId,
      table.communityId,
      table.notificationType,
    ),
  }),
);

// ──────────────────────────────────────────────
// Relations
// ──────────────────────────────────────────────
export const communitiesRelations = relations(communities, ({ many }) => ({
  monitoredSafes: many(monitoredSafes),
  notificationsSent: many(notificationsSent),
}));

export const monitoredSafesRelations = relations(monitoredSafes, ({ one }) => ({
  community: one(communities, {
    fields: [monitoredSafes.communityId],
    references: [communities.id],
  }),
}));

export const safeTransactionsRelations = relations(safeTransactions, ({ many }) => ({
  notificationsSent: many(notificationsSent),
}));

export const notificationsSentRelations = relations(notificationsSent, ({ one }) => ({
  safeTx: one(safeTransactions, {
    fields: [notificationsSent.safeTxId],
    references: [safeTransactions.id],
  }),
  community: one(communities, {
    fields: [notificationsSent.communityId],
    references: [communities.id],
  }),
}));
