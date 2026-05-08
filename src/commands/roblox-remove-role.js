'use strict';

const { SlashCommandBuilder } = require('discord.js');
const {
  autocompleteTargetRoles,
  formatRole,
  getDefaultGroupRole,
  getGroupRoles,
  isSameRole,
  logCommandAction,
  prepareUserMutation,
  replyError,
  resolveGroupRole,
  resolveRobloxUser,
} = require('./roblox/shared');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('roblox-remove-role')
    .setDescription('Remove a Roblox group role from a member')
    .addStringOption((option) => option
      .setName('user')
      .setDescription('Roblox username, Roblox ID, or Discord mention')
      .setRequired(true))
    .addUserOption((option) => option
      .setName('discord-user')
      .setDescription('Discord user to mention in command logs')
      .setRequired(true))
    .addStringOption((option) => option
      .setName('role-name')
      .setDescription('Roblox group role name to remove')
      .setRequired(true)
      .setAutocomplete(true)),

  async autocomplete(interaction) {
    return autocompleteTargetRoles(interaction, 'name', 'remove-role');
  },

  async execute(interaction) {
    const startedAt = Date.now();
    let target = null;
    let targetDiscordUser = null;
    let removeRole = null;
    let defaultRole = null;
    let context = null;
    try {
      await interaction.deferReply();
      targetDiscordUser = interaction.options.getUser('discord-user', true);
      target = await resolveRobloxUser(interaction, interaction.options.getString('user', true));
      removeRole = await resolveGroupRole(interaction.options.getString('role-name', true));
      defaultRole = getDefaultGroupRole(await getGroupRoles());
      if (!defaultRole) {
        throw new Error('No default Roblox group role was found');
      }

      context = await prepareUserMutation(interaction, 'remove-role', target, {
        cooldownRole: defaultRole,
        requireGroupMembership: true,
      });

      if (!isSameRole(context.targetRole, removeRole)) {
        throw new Error(`${target.label} has Roblox role \`${formatRole(context.targetRole)}\`, not \`${formatRole(removeRole)}\``);
      }

      if (isSameRole(context.targetRole, defaultRole)) {
        throw new Error(`${target.label} is already in the default Roblox role`);
      }

      await context.api.setMemberRole(context.groupId, target.robloxId, defaultRole.id);
      logCommandAction(interaction, {
        action: 'remove-role',
        commandName: 'roblox-remove-role',
        status: 'success',
        startedAt,
        target,
        targetDiscordId: targetDiscordUser.id,
        role: removeRole,
      });
      await interaction.editReply({
        content: `Removed Roblox role \`${formatRole(removeRole)}\` from ${target.label} (${target.robloxId}).`,
      });
    } catch (err) {
      await replyError(interaction, err, {
        action: 'remove-role',
        commandName: 'roblox-remove-role',
        startedAt,
        target,
        targetDiscordId: targetDiscordUser?.id,
        role: removeRole,
      });
    }
  },
};
