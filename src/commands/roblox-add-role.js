'use strict';

const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const config = require('../../config.json');
const {
  autocompleteAssignableRoles,
  consumeMutationCooldown,
  formatRole,
  isSameRole,
  logCommandAction,
  prepareUserMutation,
  replyError,
  resolveGroupRole,
  resolveRobloxUser,
} = require('./roblox/shared');
const {
  buildEligibilityLogFields,
  createBypassedEligibilityResult,
  evaluateAddRoleEligibility,
  renderAddRoleEligibilityResponse,
} = require('./roblox/roleEligibility');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('roblox-add-role')
    .setDescription('Add a Roblox group role to a member')
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
      .setDescription('Roblox group role name')
      .setRequired(true)
      .setAutocomplete(true))
    .addBooleanOption((option) => option
      .setName('bypass-checks')
      .setDescription('Bypass configured add-role eligibility checks')
      .setRequired(false)),

  async autocomplete(interaction) {
    return autocompleteAssignableRoles(interaction, 'name', 'add-role');
  },

  async execute(interaction) {
    const startedAt = Date.now();
    let target = null;
    let targetDiscordUser = null;
    let assignRole = null;
    let eligibility = null;
    let context = null;
    try {
      await interaction.deferReply();
      targetDiscordUser = interaction.options.getUser('discord-user', true);
      const bypassChecks = interaction.options.getBoolean('bypass-checks') === true;
      if (bypassChecks && !canUseBypassChecks(interaction)) {
        throw new Error(
          'Only server administrators or configured bypass roles can bypass add-role eligibility checks',
        );
      }
      target = await resolveRobloxUser(interaction, interaction.options.getString('user', true));
      assignRole = await resolveGroupRole(interaction.options.getString('role-name', true));
      context = await prepareUserMutation(interaction, 'add-role', target, {
        assignRole,
        consumeCooldown: false,
        requireGroupMembership: false,
      });

      if (isSameRole(context.targetRole, context.assignRole)) {
        throw new Error(`${target.label} already has Roblox role \`${formatRole(context.assignRole)}\``);
      }

      eligibility = bypassChecks
        ? createBypassedEligibilityResult()
        : await evaluateAddRoleEligibility(
          context.api,
          target,
          context.assignRole,
          context.groupId,
          context.targetRole,
        );

      if (!eligibility.allowed) {
        logCommandAction(interaction, {
          action: 'add-role',
          commandName: 'roblox-add-role',
          status: 'failed',
          startedAt,
          target,
          targetDiscordId: targetDiscordUser.id,
          role: context.assignRole,
          error: 'Requirements not met',
          fields: buildEligibilityLogFields(eligibility),
        });
        await interaction.editReply(renderAddRoleEligibilityResponse({
          target,
          role: context.assignRole,
          result: eligibility,
        }));
        return;
      }

      consumeMutationCooldown(interaction.user.id, 'add-role', context.targetRole, context.assignRole);
      await context.api.assignMemberRole(context.groupId, target.robloxId, context.assignRole.id);
      logCommandAction(interaction, {
        action: 'add-role',
        commandName: 'roblox-add-role',
        status: 'success',
        startedAt,
        target,
        targetDiscordId: targetDiscordUser.id,
        role: context.assignRole,
        fields: buildEligibilityLogFields(eligibility),
      });
      await interaction.editReply({
        content: `Added Roblox role \`${formatRole(context.assignRole)}\` to ${target.label} (${target.robloxId}).`,
      });
    } catch (err) {
      await replyError(interaction, err, {
        action: 'add-role',
        commandName: 'roblox-add-role',
        startedAt,
        target,
        targetDiscordId: targetDiscordUser?.id,
        role: context?.assignRole || assignRole,
        fields: buildEligibilityLogFields(eligibility),
      });
    }
  },
};

function canUseBypassChecks(interaction) {
  if (interaction?.memberPermissions?.has?.(PermissionFlagsBits.Administrator)) {
    return true;
  }

  const bypassRoleIds = getBypassRoleIds();
  if (bypassRoleIds.size === 0) {
    return false;
  }

  return getInteractionRoleIds(interaction).some((roleId) => bypassRoleIds.has(roleId));
}

function getBypassRoleIds() {
  return new Set(toStringArray(config.DISCORD?.BYPASS_ROLE_IDS));
}

function getInteractionRoleIds(interaction) {
  const roles = interaction?.member?.roles;
  if (roles?.cache?.keys) {
    return [...roles.cache.keys()].map((roleId) => String(roleId));
  }

  if (Array.isArray(roles)) {
    return roles.map((roleId) => String(roleId).trim()).filter(Boolean);
  }

  return [];
}

function toStringArray(value) {
  return Array.isArray(value)
    ? value.map((entry) => String(entry).trim()).filter(Boolean)
    : [];
}
