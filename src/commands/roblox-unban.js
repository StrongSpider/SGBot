'use strict';

const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const {
  logCommandAction,
  prepareUserMutation,
  replyError,
  resolveRobloxUser,
} = require('./roblox/shared');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('roblox-unban')
    .setDescription('Unban a Roblox user from the group')
    .addStringOption((option) => option
      .setName('user')
      .setDescription('Roblox username, Roblox ID, or Discord mention')
      .setRequired(true)),

  async execute(interaction) {
    const startedAt = Date.now();
    let target = null;
    let context = null;
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      target = await resolveRobloxUser(interaction, interaction.options.getString('user', true));
      context = await prepareUserMutation(interaction, 'unban', target);

      await context.api.unbanGroupUser(context.groupId, target.robloxId);
      logCommandAction(interaction, {
        action: 'unban',
        commandName: 'roblox-unban',
        status: 'success',
        startedAt,
        target,
      });
      await interaction.editReply({ content: `Unbanned ${target.label} (${target.robloxId}) from the Roblox group.` });
    } catch (err) {
      await replyError(interaction, err, {
        action: 'unban',
        commandName: 'roblox-unban',
        startedAt,
        target,
      });
    }
  },
};
