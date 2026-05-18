import type { Context, NextFunction } from 'grammy';
import { getCommunityByChatId, upsertCommunity, updateCommunityAdmins } from '../db/queries.js';

/**
 * Refresh admin list for a chat from Telegram API.
 * Stores admin IDs as strings (bigint-safe).
 */
export async function refreshAdmins(ctx: Context): Promise<string[]> {
  if (!ctx.chat) return [];

  const chatType = ctx.chat.type;
  if (chatType === 'private') {
    // In private chats, the user themselves is effectively the admin
    const userId = ctx.from?.id;
    if (userId) {
      const adminIds = [userId.toString()];
      if (ctx.chat) {
        await upsertCommunity({
          telegramChatId: BigInt(ctx.chat.id),
          chatType,
          chatTitle: null,
          adminUserIds: adminIds,
        });
      }
      return adminIds;
    }
    return [];
  }

  try {
    const members = await ctx.getChatAdministrators();
    const adminIds = members.map((m) => m.user.id.toString());

    if (ctx.chat) {
      await updateCommunityAdmins(BigInt(ctx.chat.id), adminIds);
    }

    return adminIds;
  } catch (err) {
    console.error('[middleware] Failed to fetch admins:', err);
    return [];
  }
}

/**
 * Middleware: ensure the community record exists in the DB.
 * Call on every message to keep community info fresh.
 */
export async function ensureCommunity(ctx: Context, next: NextFunction): Promise<void> {
  if (!ctx.chat) {
    await next();
    return;
  }

  try {
    const chatTitle =
      'title' in ctx.chat ? ctx.chat.title : ('username' in ctx.chat ? ctx.chat.username : null);

    let adminIds: string[] = [];
    const existing = await getCommunityByChatId(BigInt(ctx.chat.id));

    if (existing) {
      adminIds = (existing.adminUserIds as string[]) ?? [];
    } else {
      // New community — fetch admins
      if (ctx.chat.type !== 'private') {
        try {
          const members = await ctx.getChatAdministrators();
          adminIds = members.map((m) => m.user.id.toString());
        } catch {
          // Can fail in channels — use empty list
        }
      } else {
        if (ctx.from) {
          adminIds = [ctx.from.id.toString()];
        }
      }

      await upsertCommunity({
        telegramChatId: BigInt(ctx.chat.id),
        chatType: ctx.chat.type,
        chatTitle: chatTitle ?? null,
        adminUserIds: adminIds,
      });
    }
  } catch (err) {
    console.error('[middleware] ensureCommunity error:', err);
  }

  await next();
}

/**
 * Middleware: require admin to perform action.
 * Replies with error if caller is not admin, otherwise calls next().
 */
export function requireAdmin(ctx: Context, next: NextFunction): Promise<void> {
  return checkAdmin(ctx, next);
}

async function checkAdmin(ctx: Context, next: NextFunction): Promise<void> {
  if (!ctx.from || !ctx.chat) {
    await ctx.reply('Unable to verify permissions.');
    return;
  }

  const userId = ctx.from.id.toString();

  // Always refresh admin list on admin commands to keep it current
  const currentAdmins = await refreshAdmins(ctx);

  if (currentAdmins.length === 0 || currentAdmins.includes(userId)) {
    await next();
    return;
  }

  await ctx.reply('❌ This command is only available to group admins.');
}
