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
  resolveGroupRoles,
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
      .setDescription('Roblox group role name(s) to remove, separated by commas')
      .setRequired(true)
      .setAutocomplete(true)),

  async autocomplete(interaction) {
    return autocompleteTargetRoles(interaction, 'name', 'remove-role', { allowList: true });
  },

  async execute(interaction) {
    const startedAt = Date.now();
    let target = null;
    let targetDiscordUser = null;
    let removeRoles = [];
    let removeRole = null;
    let defaultRole = null;
    let context = null;
    try {
      await interaction.deferReply();
      targetDiscordUser = interaction.options.getUser('discord-user', true);
      target = await resolveRobloxUser(interaction, interaction.options.getString('user', true));
      removeRoles = await resolveGroupRoles(interaction.options.getString('role-name', true));
      defaultRole = getDefaultGroupRole(await getGroupRoles());
      if (!defaultRole) {
        throw new Error('No default Roblox group role was found');
      }

      context = await prepareUserMutation(interaction, 'remove-role', target, {
        cooldownRole: defaultRole,
        requireGroupMembership: true,
      });

      removeRole = removeRoles.find((role) => isSameRole(context.targetRole, role)) || null;
      if (!removeRole) {
        throw new Error(buildRoleMismatchMessage(target, context.targetRole, removeRoles));
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
      return true;
    } catch (err) {
      await replyError(interaction, err, {
        action: 'remove-role',
        commandName: 'roblox-remove-role',
        startedAt,
        target,
        targetDiscordId: targetDiscordUser?.id,
        role: removeRole || getSingleLogRole(removeRoles),
        fields: buildRemoveRolesLogFields(removeRoles),
      });
      return false;
    }
  },
};

function buildRoleMismatchMessage(target, targetRole, removeRoles) {
  if (removeRoles.length === 1) {
    return `${target.label} has Roblox role \`${formatRole(targetRole)}\`, not \`${formatRole(removeRoles[0])}\``;
  }

  return `${target.label} has Roblox role \`${formatRole(targetRole)}\`, not one of ${formatRoleList(removeRoles)}`;
}

function formatRoleList(roles) {
  return roles.map((role) => `\`${formatRole(role)}\``).join(', ');
}

function getSingleLogRole(roles) {
  return roles.length === 1 ? roles[0] : null;
}

function buildRemoveRolesLogFields(roles) {
  if (roles.length <= 1) {
    return [];
  }

  return [{ name: 'Roles', value: roles.map((role) => formatRole(role)).join(', '), inline: false }];
}
