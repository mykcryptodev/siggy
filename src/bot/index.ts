import { Bot } from 'grammy';
import { upsertCommunity, updateCommunityAdmins } from '../db/queries.js';
import { registerAllCommands } from './commands.js';

if (!process.env.TELEGRAM_BOT_TOKEN) {
  throw new Error('TELEGRAM_BOT_TOKEN environment variable is required');
}

// Create the Grammy bot instance
// This module is imported by both api/telegram.ts (webhook) and by the notifier
export const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

// ──────────────────────────────────────────────
// Register bot join/leave events
// ──────────────────────────────────────────────

bot.on('my_chat_member', async (ctx) => {
  const update = ctx.myChatMember;
  const newStatus = update.new_chat_member.status;
  const chat = ctx.chat;

  if (!chat) return;

  const chatTitle = 'title' in chat ? chat.title : ('username' in chat ? chat.username : null);

  if (newStatus === 'member' || newStatus === 'administrator') {
    // Bot joined a chat — record community and fetch admins
    let adminIds: string[] = [];

    if (chat.type !== 'private') {
      try {
        const members = await ctx.getChatAdministrators();
        adminIds = members.map((m) => m.user.id.toString());
      } catch {
        // Ignore — might not have permission yet
      }
    } else if (ctx.from) {
      adminIds = [ctx.from.id.toString()];
    }

    await upsertCommunity({
      telegramChatId: BigInt(chat.id),
      chatType: chat.type,
      chatTitle: chatTitle ?? null,
      adminUserIds: adminIds,
    });

    if (chat.type !== 'private') {
      await ctx.reply(
        `👋 Hi! I'm <b>Siggy</b>, your Safe multisig transparency bot.\n\n` +
        `Group admins can run <code>/addsafe &lt;address&gt;</code> to start monitoring a Safe.\n\n` +
        `Type <code>/help</code> for all commands.`,
        { parse_mode: 'HTML' },
      );
    }
  }

  if (newStatus === 'kicked' || newStatus === 'left') {
    // Bot was removed — we keep the DB record but could mark inactive
    // For now just log
    console.log(`[bot] Removed from chat ${chat.id}`);
  }
});

// ──────────────────────────────────────────────
// Handle admin changes in groups
// ──────────────────────────────────────────────

bot.on('chat_member', async (ctx) => {
  // When any member's status changes, refresh admin list
  const chat = ctx.chat;
  if (!chat || chat.type === 'private') return;

  const newStatus = ctx.chatMember.new_chat_member.status;
  const oldStatus = ctx.chatMember.old_chat_member.status;

  // Only care about admin role changes
  const adminStatuses = ['administrator', 'creator'];
  const wasAdmin = adminStatuses.includes(oldStatus);
  const isAdmin = adminStatuses.includes(newStatus);

  if (wasAdmin !== isAdmin) {
    try {
      const members = await ctx.getChatAdministrators();
      const adminIds = members.map((m) => m.user.id.toString());
      await updateCommunityAdmins(BigInt(chat.id), adminIds);
    } catch (err) {
      console.error('[bot] Failed to refresh admins:', err);
    }
  }
});

// ──────────────────────────────────────────────
// Register commands
// ──────────────────────────────────────────────

registerAllCommands(bot);

// ──────────────────────────────────────────────
// Error handler
// ──────────────────────────────────────────────

bot.catch((err) => {
  console.error('[bot] Unhandled error:', err.error);
});
