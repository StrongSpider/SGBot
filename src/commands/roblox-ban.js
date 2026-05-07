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
    .setName('roblox-ban')
    .setDescription('Ban a Roblox user from the group')
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
      context = await prepareUserMutation(interaction, 'ban', target);

      await context.api.banGroupUser(context.groupId, target.robloxId);
      logCommandAction(interaction, {
        action: 'ban',
        commandName: 'roblox-ban',
        status: 'success',
        startedAt,
        target,
      });
      await interaction.editReply({ content: `Banned ${target.label} (${target.robloxId}) from the Roblox group.` });
    } catch (err) {
      await replyError(interaction, err, {
        action: 'ban',
        commandName: 'roblox-ban',
        startedAt,
        target,
      });
    }
  },
};
