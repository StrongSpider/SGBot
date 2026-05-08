/**
 * @fileoverview Shared helpers for Roblox slash commands.
 */
'use strict';

const config = require('../../../config.json');
const path = require('path');
const { MessageFlags, PermissionFlagsBits } = require('discord.js');
const {
  createRobloxApi,
  readCookieFile,
  writeCookieFile,
} = require('../../api/roblox');
const {
  extractDiscordIdFromMention,
  getRobloxIdFromDiscordId,
} = require('../../api/bloxlink');
const { toArray } = require('../../api/roblox/helpers');
const LoggerClass = require('../../api/logger');
const logger = new LoggerClass('RobloxCommands', 'BOT');

const ALL_ACTIONS = Object.freeze([
  'add-role',
  'remove-role',
  'ban',
  'kick',
  'unban',
]);

const ROLE_CACHE_TTL_MS = 60000;
const ACTION_ALIASES = Object.freeze({
  rank: ['add-role', 'remove-role'],
});
const RANK_ACTIONS = new Set(ACTION_ALIASES.rank);
const MEMBER_ROBLOX_ROLE_ID = '12884901889';

const DEFAULT_ANTI_NUKE = Object.freeze({
  MUTATING: { LIMIT: 3, WINDOW_MS: 10 * 60 * 1000 },
  RANK: { LIMIT: 3, WINDOW_MS: 10 * 60 * 1000 },
  DERANK: { LIMIT: 1, WINDOW_MS: 30 * 60 * 1000 },
});

const cooldownHits = new Map();
let robloxApi;
let roleCache = {
  fetchedAt: 0,
  roles: [],
};

function getRobloxApi() {
  if (!robloxApi) {
    const cookieFilePath = getCookieFilePath();
    const fileCookie = readCookieFile(cookieFilePath);
    const fallbackCookie = String(config.ROBLOX?.COOKIE || '').trim();
    if (!fileCookie && fallbackCookie) {
      writeCookieFile(fallbackCookie, cookieFilePath);
    }

    robloxApi = createRobloxApi({
      cookie: fileCookie || fallbackCookie,
      apiKey: config.ROBLOX?.API_KEY,
      onCookieUpdate: (cookieHeader) => writeCookieFile(cookieHeader, cookieFilePath),
    });
  }
  return robloxApi;
}

function getCookieFilePath() {
  const fileName = String(config.ROBLOX?.COOKIE_FILE || 'COOKIE').trim() || 'COOKIE';
  return path.resolve(__dirname, '../../../', fileName);
}

function getGroupId() {
  const groupId = String(config.ROBLOX?.GROUP_ID || '').trim();
  if (!/^\d+$/.test(groupId)) {
    throw new Error('ROBLOX.GROUP_ID is missing or invalid in config.json');
  }
  return groupId;
}

async function resolveRobloxUser(interaction, value) {
  const raw = String(value || '').trim();
  if (!raw) {
    throw new Error('Roblox user is required');
  }

  const api = getRobloxApi();
  if (/^\d+$/.test(raw)) {
    const user = await api.getUserById(raw);
    if (!user) {
      throw new Error(`No Roblox user found for ID ${raw}`);
    }
    return {
      robloxId: String(user.id),
      label: user.name,
      source: 'robloxId',
    };
  }

  if (isPossibleUsername(raw)) {
    const user = await api.getUserByUsername(raw).catch((err) => {
      if (/Invalid Roblox username/i.test(err?.message || '')) {
        return null;
      }
      throw err;
    });
    if (user) {
      return {
        robloxId: String(user.id),
        label: user.name,
        source: 'username',
      };
    }
  }

  const discordId = extractDiscordIdFromMention(raw);
  if (discordId) {
    const robloxId = await getRobloxIdFromDiscordId(discordId, getBloxlinkOptions(interaction));
    if (!robloxId) {
      throw new Error('That Discord user is not linked through Bloxlink');
    }
    return {
      robloxId: String(robloxId),
      discordId,
      label: `<@${discordId}>`,
      source: 'discordMention',
    };
  }

  throw new Error('Roblox user must be a username, Roblox ID, or Discord mention');
}

function getBloxlinkOptions(interaction) {
  const token = String(config.BLOXLINK?.GUILD_TOKEN || '').trim();
  if (!token) {
    throw new Error('BLOXLINK.GUILD_TOKEN is missing in config.json');
  }

  return {
    guildId: interaction.guildId || config.DISCORD?.BOT?.GUILD_ID,
    guildToken: token,
  };
}

async function getGroupRoles(options = {}) {
  const now = Date.now();
  if (!options.force && roleCache.roles.length > 0 && now - roleCache.fetchedAt < ROLE_CACHE_TTL_MS) {
    return roleCache.roles;
  }

  const roles = await getRobloxApi().listGroupRoles(getGroupId());
  roleCache = {
    fetchedAt: now,
    roles,
  };
  return roles;
}

async function autocompleteAssignableRoles(interaction, valueMode = 'id', action = 'add-role') {
  return autocompleteRoles(interaction, action, valueMode, isAssignableRole);
}

async function autocompleteTargetRoles(interaction, valueMode = 'id', action = 'remove-role') {
  return autocompleteRoles(interaction, action, valueMode, isTargetRole);
}

async function autocompleteRoles(interaction, action, valueMode, predicate) {
  const policy = getPolicyForMember(interaction.member, interaction.user?.id);
  if (!policy.allowedActions.has(action)) {
    return interaction.respond([]);
  }

  const focused = normalizeAutocompleteQuery(interaction.options.getFocused());
  const roles = await getGroupRoles().catch((err) => {
    logCaughtError(`Caught ${action} autocomplete role fetch error`, err);
    return [];
  });
  const choices = roles
    .filter((role) => predicate(role, policy))
    .filter((role) => matchesRoleAutocomplete(role, focused))
    .sort((a, b) => Number(a.rank || 0) - Number(b.rank || 0))
    .slice(0, 25)
    .map((role) => ({
      name: formatRoleChoiceName(role),
      value: formatRoleChoiceValue(role, valueMode),
    }));

  return interaction.respond(choices);
}

async function resolveGroupRole(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    throw new Error('Roblox role is required');
  }

  const roles = await getGroupRoles();
  const lower = raw.toLowerCase();
  const byName = roles.find((role) => String(role?.name || role?.displayName || '').trim().toLowerCase() === lower);
  if (byName) {
    return byName;
  }

  throw new Error('No Roblox group role found for that name');
}

function getDefaultGroupRole(roles) {
  return toArray(roles)
    .filter((role) => {
      const rank = Number(role?.rank);
      return Number.isFinite(rank) && rank > 0 && rank < 255;
    })
    .sort((a, b) => Number(a.rank || 0) - Number(b.rank || 0))[0] || null;
}

async function prepareUserMutation(interaction, action, target, options = {}) {
  const policy = getPolicyForMember(interaction.member, interaction.user?.id);
  assertActionAllowed(policy, action);
  await assertDiscordTargetAllowed(interaction, target, policy);

  const api = getRobloxApi();
  const groupId = getGroupId();
  let assignRole = options.assignRole || null;
  if (!assignRole && typeof options.assignRank !== 'undefined') {
    assignRole = await api.findGroupRoleByRank(groupId, options.assignRank);
    if (!assignRole) {
      throw new Error('No Roblox group role found for that selection');
    }
  }
  const targetRole = await api.getUserGroupRole(groupId, target.robloxId).catch((err) => {
    logCaughtError(`Caught ${action} target role lookup error`, err);
    return null;
  });

  if (!targetRole && options.requireGroupMembership) {
    throw new Error('Target user is not in the configured Roblox group');
  }

  if (targetRole) {
    assertTargetRankAllowed(targetRole, policy);
  }

  if (assignRole) {
    assertAssignableRoleAllowed(assignRole, policy);
  }

  if (options.consumeCooldown !== false) {
    consumeMutationCooldown(interaction.user.id, action, targetRole, options.cooldownRole || assignRole);
  }
  return {
    api,
    groupId,
    policy,
    assignRole,
    targetRole,
  };
}

function getPolicyForMember(member, userId) {
  if (isRobloxPermissionBypassUser(userId)) {
    return {
      bypass: true,
      allowedActions: new Set(ALL_ACTIONS),
      targetRoleIds: new Set(),
      assignableRoleIds: new Set(),
    };
  }

  const permissionConfig = config.ROBLOX?.PERMISSIONS || {};
  const memberRoleIds = getMemberRoleIds(member);
  const policies = Array.isArray(permissionConfig.ROLE_POLICIES)
    ? permissionConfig.ROLE_POLICIES
    : [];

  const combined = {
    bypass: false,
    allowedActions: new Set(),
    targetRoleIds: new Set(),
    assignableRoleIds: new Set(),
  };

  for (const policy of policies) {
    const roleIds = getPolicyRoleIds(policy);
    if (roleIds.length === 0 || !roleIds.some((roleId) => memberRoleIds.has(roleId))) {
      continue;
    }

    const actions = toStringArray(policy.ACTIONS);
    if (actions.includes('*')) {
      for (const action of ALL_ACTIONS) combined.allowedActions.add(action);
    } else {
      for (const action of actions) {
        for (const resolvedAction of expandPolicyAction(action)) {
          if (ALL_ACTIONS.includes(resolvedAction)) {
            combined.allowedActions.add(resolvedAction);
          }
        }
      }
    }

    for (const roleId of getPolicyRobloxRoleIds(policy, 'TARGET')) {
      combined.targetRoleIds.add(roleId);
    }
    for (const roleId of getPolicyRobloxRoleIds(policy, 'ASSIGNABLE')) {
      combined.assignableRoleIds.add(roleId);
    }
  }

  return combined;
}

function isRobloxPermissionBypassUser(userId) {
  const permissionConfig = config.ROBLOX?.PERMISSIONS || {};
  return toStringArray(permissionConfig.BYPASS_DISCORD_USER_IDS)
    .includes(String(userId));
}

function isCommandPermissionAdmin(interaction) {
  return Boolean(
    interaction?.memberPermissions?.has?.(PermissionFlagsBits.Administrator) ||
      isRobloxPermissionBypassUser(interaction?.user?.id),
  );
}

function assertActionAllowed(policy, action) {
  if (!policy.allowedActions.has(action)) {
    throw new Error('You do not have permission to use this Roblox command');
  }
}

async function assertDiscordTargetAllowed(interaction, target, policy) {
  if (policy.bypass || !target.discordId || !interaction.guild) {
    return;
  }

  if (target.discordId === interaction.user.id) {
    throw new Error('You cannot use this command on yourself');
  }

  const targetMember = await interaction.guild.members.fetch(target.discordId).catch((err) => {
    logCaughtError('Caught Discord target member fetch error', err);
    return null;
  });
  const executorMember = interaction.member?.roles?.highest
    ? interaction.member
    : await interaction.guild.members.fetch(interaction.user.id).catch((err) => {
      logCaughtError('Caught Discord executor member fetch error', err);
      return interaction.member;
    });
  if (!targetMember || !executorMember?.roles?.highest) {
    return;
  }

  if (executorMember.roles.highest.comparePositionTo(targetMember.roles.highest) <= 0) {
    throw new Error('Your highest Discord role must be above the target member');
  }
}

function getMemberRoleIds(member) {
  if (member?.roles?.cache?.keys) {
    return new Set(member.roles.cache.keys());
  }

  if (Array.isArray(member?.roles)) {
    return new Set(member.roles.map((roleId) => String(roleId)));
  }

  return new Set();
}

function getPolicyRoleIds(policy) {
  return [...new Set(toStringArray(policy.DISCORD_ROLE_IDS))];
}

function getPolicyRobloxRoleIds(policy, policyType) {
  const key = policyType === 'TARGET' ? 'TARGET_ROLE_IDS' : 'ASSIGNABLE_ROLE_IDS';
  const roleIds = toStringArray(policy?.[key]);
  const uniqueRoleIds = [...new Set(roleIds)];
  if (policyType === 'TARGET') {
    return uniqueRoleIds.filter((roleId) => roleId !== MEMBER_ROBLOX_ROLE_ID);
  }
  return uniqueRoleIds;
}

function assertTargetRankAllowed(role, policy) {
  const rank = Number(role.rank);
  const roleId = String(role?.id || '').trim();
  if (!Number.isFinite(rank)) {
    return;
  }

  if (rank >= 255) {
    throw new Error('The Roblox group owner rank cannot be targeted');
  }

  if (roleId === MEMBER_ROBLOX_ROLE_ID) {
    throw new Error('The Roblox group member role cannot be targeted');
  }

  if (policy.bypass) {
    return;
  }

  if (roleId && policy.targetRoleIds.has(roleId)) {
    return;
  }

  if (policy.targetRoleIds.size > 0) {
    throw new Error(`You cannot target Roblox role \`${formatRole(role)}\``);
  }

  throw new Error('You do not have permission to target this Roblox role');
}

function assertAssignableRoleAllowed(role, policy) {
  if (!isAssignableRole(role, policy)) {
    throw new Error(`You cannot assign Roblox role \`${formatRole(role)}\``);
  }
}

function isAssignableRole(role, policy) {
  const rank = Number(role?.rank);
  const roleId = String(role?.id || '').trim();
  if (!Number.isFinite(rank) || rank <= 0 || rank >= 255) {
    return false;
  }

  if (policy.bypass) {
    return true;
  }

  if (roleId && policy.assignableRoleIds.has(roleId)) {
    return true;
  }

  return false;
}

function isTargetRole(role, policy) {
  const rank = Number(role?.rank);
  const roleId = String(role?.id || '').trim();
  if (!Number.isFinite(rank) || rank <= 0 || rank >= 255) {
    return false;
  }

  if (roleId === MEMBER_ROBLOX_ROLE_ID) {
    return false;
  }

  if (policy.bypass) {
    return true;
  }

  if (roleId && policy.targetRoleIds.has(roleId)) {
    return true;
  }

  return false;
}

function isSameRole(left, right) {
  const leftId = String(left?.id || '').trim();
  const rightId = String(right?.id || '').trim();
  if (leftId && rightId) {
    return leftId === rightId;
  }

  const leftRank = Number(left?.rank);
  const rightRank = Number(right?.rank);
  return Number.isFinite(leftRank) && Number.isFinite(rightRank) && leftRank === rightRank;
}

function consumeCooldown(userId, scope) {
  const rule = getCooldownRule(scope.category);
  const now = Date.now();
  const key = `${userId}:${scope.key}`;
  const hits = (cooldownHits.get(key) || []).filter((timestamp) => now - timestamp < rule.windowMs);

  if (hits.length >= rule.limit) {
    const resetAt = hits[0] + rule.windowMs;
    throw new Error(`${scope.label} cooldown active. Try again in ${formatDuration(resetAt - now)}.`);
  }

  hits.push(now);
  cooldownHits.set(key, hits);
}

function consumeMutationCooldown(userId, action, oldRole, newRole) {
  consumeCooldown(userId, getCooldownScope(action, oldRole, newRole));
}

function getCooldownScope(action, oldRole, newRole) {
  const category = getCooldownCategory(action, oldRole, newRole);
  if (category === 'DERANK') {
    return { category, key: 'derank', label: 'Derank' };
  }
  if (category === 'RANK') {
    return { category, key: 'rank', label: 'Rank' };
  }
  return { category: 'MUTATING', key: action, label: 'Anti-nuke' };
}

function getCooldownCategory(action, oldRole, newRole) {
  if (!RANK_ACTIONS.has(action)) {
    return 'MUTATING';
  }

  const oldRank = Number(oldRole?.rank);
  const newRank = Number(newRole?.rank);
  if (Number.isFinite(oldRank) && Number.isFinite(newRank) && newRank < oldRank) {
    return 'DERANK';
  }

  return 'RANK';
}

function getCooldownRule(category = 'MUTATING') {
  const antiNuke = config.ROBLOX?.ANTI_NUKE || {};
  const defaultRule = DEFAULT_ANTI_NUKE[category] || DEFAULT_ANTI_NUKE.MUTATING;
  const raw = getCooldownConfig(antiNuke, category) ||
    (category === 'RANK' ? getCooldownConfig(antiNuke, 'MUTATING') : null) ||
    defaultRule;
  return {
    limit: Math.max(1, Number(raw.LIMIT ?? defaultRule.LIMIT)),
    windowMs: Math.max(1000, Number(raw.WINDOW_MS ?? defaultRule.WINDOW_MS)),
  };
}

function getCooldownConfig(antiNuke, category) {
  return antiNuke[category] || null;
}

function toStringArray(value) {
  return Array.isArray(value)
    ? value.map((entry) => String(entry).trim()).filter(Boolean)
    : [];
}

function expandPolicyAction(action) {
  return ACTION_ALIASES[action] || [action];
}

function isPossibleUsername(value) {
  return /^[A-Za-z0-9_]{3,20}$/.test(String(value || '').trim());
}

function matchesRoleAutocomplete(role, focused) {
  if (!focused) {
    return true;
  }

  return getRoleAutocompleteSearchValues(role)
    .some((value) => value.includes(focused));
}

function normalizeAutocompleteQuery(value) {
  return String(value || '').trim().toLowerCase();
}

function getRoleAutocompleteSearchValues(role) {
  return [
    role?.name,
    role?.displayName,
    role?.id,
    role?.rank,
  ]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);
}

function formatRoleChoiceName(role) {
  return String(role?.name || 'Unnamed role').trim() || 'Unnamed role';
}

function formatRoleChoiceValue(role, valueMode) {
  if (valueMode === 'rank') {
    return Number(role.rank);
  }
  if (valueMode === 'id') {
    return String(role.id);
  }
  return formatRoleChoiceName(role);
}

function formatRole(role) {
  if (!role) {
    return 'unknown role';
  }
  return String(role.name || role.displayName || 'Unnamed role').trim() || 'Unnamed role';
}

function formatDuration(ms) {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.ceil(seconds / 60);
  return `${minutes}m`;
}

function toErrorMessage(err) {
  return err?.message ? err.message : String(err);
}

function logCaughtError(context, err) {
  const label = String(context || 'Caught error').trim() || 'Caught error';
  logger.error(`${label}:`, err);
}

function logCommandAction(interaction, details = {}) {
  if (!interaction) {
    return;
  }

  const commandName = String(details.commandName || interaction.commandName || 'unknown').trim();
  const startedAt = Number(details.startedAt);
  const durationMs = Number.isFinite(Number(details.durationMs)) ?
    Number(details.durationMs) :
    (Number.isFinite(startedAt) ? Date.now() - startedAt : undefined);
  const targetDiscordId = getCommandActionDiscordUserId(details);

  LoggerClass.commandAction({
    title: details.title,
    commandName,
    commandInvocation: details.commandInvocation || `/${commandName}`,
    action: details.action || commandName,
    status: details.status || 'success',
    userId: interaction.user?.id,
    username: interaction.user?.tag || interaction.user?.username,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    durationMs,
    error: details.error,
    mentionUserIds: [
      interaction.user?.id,
      targetDiscordId,
      ...(Array.isArray(details.mentionUserIds) ? details.mentionUserIds : []),
    ],
    fields: buildCommandActionFields(details),
  });
}

function buildCommandActionFields(details = {}) {
  const fields = Array.isArray(details.fields) ? details.fields.slice() : [];
  const targetDiscordId = getCommandActionDiscordUserId(details);

  if (details.target) {
    fields.push(
      { name: 'Roblox Account', value: formatCommandActionTargetLabel(details.target), inline: true },
    );

    if (targetDiscordId) {
      fields.push({ name: 'Discord User', value: `<@${targetDiscordId}>`, inline: true });
    }

    fields.push(
      { name: 'Roblox ID', value: details.target.robloxId || 'unknown', inline: true },
    );
  } else if (targetDiscordId) {
    fields.push({ name: 'Discord User', value: `<@${targetDiscordId}>`, inline: true });
  }
  if (details.role || details.assignRole) {
    fields.push({ name: 'Role', value: formatCommandActionRole(details.role || details.assignRole), inline: true });
  }

  return fields;
}

function getCommandActionDiscordUserId(details = {}) {
  const candidates = [
    details.targetDiscordId,
    details.targetDiscordUser?.id,
    details.target?.discordId,
  ];
  for (const candidate of candidates) {
    const id = String(candidate || '').trim();
    if (/^\d+$/.test(id)) {
      return id;
    }
  }
  return '';
}

function formatCommandActionTargetLabel(target) {
  const label = String(target?.label || 'unknown').trim() || 'unknown';
  if (/^<@!?\d+>$/.test(label)) {
    return 'Resolved from Discord mention';
  }
  return label;
}

function formatCommandActionRole(role) {
  const label = formatRole(role);
  const id = role?.id ? ` (${role.id})` : '';
  return `${label}${id}`;
}

async function replyError(interaction, err, logDetails = null) {
  const commandName = String(logDetails?.commandName || interaction?.commandName || 'command').trim();
  logCaughtError(`Caught error in ${commandName}`, err);

  if (logDetails) {
    logCommandAction(interaction, {
      ...logDetails,
      status: logDetails.status || 'failed',
      error: toErrorMessage(err),
    });
  }

  const content = `**<:failed:1499541219154329700>Failed:** ${toErrorMessage(err)}`;
  if (interaction.deferred || interaction.replied) {
    return interaction.editReply({ content });
  }
  return interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

module.exports = {
  ALL_ACTIONS,
  autocompleteAssignableRoles,
  autocompleteTargetRoles,
  consumeMutationCooldown,
  formatRole,
  getDefaultGroupRole,
  getGroupId,
  getGroupRoles,
  getPolicyForMember,
  getRobloxApi,
  isCommandPermissionAdmin,
  isSameRole,
  logCaughtError,
  logCommandAction,
  prepareUserMutation,
  replyError,
  resolveGroupRole,
  resolveRobloxUser,
};
