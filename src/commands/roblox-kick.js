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
    .setName('roblox-kick')
    .setDescription('Kick a Roblox user from the group')
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
      context = await prepareUserMutation(interaction, 'kick', target, {
        requireGroupMembership: true,
      });

      await context.api.kickGroupUser(context.groupId, target.robloxId);
      logCommandAction(interaction, {
        action: 'kick',
        commandName: 'roblox-kick',
        status: 'success',
        startedAt,
        target,
      });
      await interaction.editReply({ content: `Kicked ${target.label} (${target.robloxId}) from the Roblox group.` });
      return true;
    } catch (err) {
      await replyError(interaction, err, {
        action: 'kick',
        commandName: 'roblox-kick',
        startedAt,
        target,
      });
      return false;
    }
  },
};
