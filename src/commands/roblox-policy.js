'use strict';

const fs = require('fs');
const path = require('path');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  RoleSelectMenuBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
} = require('discord.js');

const config = require('../../config.json');
const {
  getGroupId,
  getGroupRoles,
  isCommandPermissionAdmin,
  getRobloxApi,
  logCommandAction,
  logCaughtError,
  replyError,
} = require('./roblox/shared');

const CONFIG_PATH = path.resolve(__dirname, '../../config.json');
const SESSION_PREFIX = 'roblox-policy';
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_SELECT_OPTIONS = 25;
const ACTION_CHOICES = Object.freeze([
  { value: 'add-role', label: 'Add Role' },
  { value: 'remove-role', label: 'Remove Role' },
  { value: 'ban', label: 'Ban' },
  { value: 'kick', label: 'Kick' },
  { value: 'unban', label: 'Unban' },
]);
const SUPPORTED_ACTIONS = new Set(ACTION_CHOICES.map((choice) => choice.value));
const ACTION_ALIASES = Object.freeze({
  rank: ['add-role', 'remove-role'],
});
const MEMBER_ROBLOX_ROLE_ID = '12884901889';

const sessions = new Map();

module.exports = {
  data: new SlashCommandBuilder()
    .setName('roblox-policy')
    .setDescription('Interactive Roblox role policy editor'),

  async execute(interaction) {
    try {
      assertAdministrator(interaction);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const session = await createSession(interaction);
      await interaction.editReply(renderEditor(session));
      return true;
    } catch (err) {
      await replyError(interaction, err);
      return false;
    }
  },

  async handleComponent(interaction) {
    const startedAt = Date.now();
    let session = null;
    let action = 'component';
    try {
      assertAdministrator(interaction);
      session = getSessionFromCustomId(interaction.customId);
      action = session.action;
      assertSessionOwner(session.state, interaction.user.id);
      touchSession(session.state);

      if (action === 'pick') {
        handlePickPolicy(interaction, session.state);
      } else if (action === 'roles') {
        handlePickRoles(interaction, session.state);
      } else if (action === 'actions') {
        handlePickActions(interaction, session.state);
      } else if (action.startsWith('target-roles-')) {
        handlePickTargetRoles(interaction, session.state, getPagedActionIndex(action, 'target-roles-'));
      } else if (action.startsWith('assign-roles-')) {
        handlePickAssignRoles(interaction, session.state, getPagedActionIndex(action, 'assign-roles-'));
      } else {
        switch (action) {
          case 'new':
          case 'save':
          case 'remove':
          case 'refresh':
            await handleButtonAction(interaction, session, startedAt);
            return;
          default:
            throw new Error('Unknown Roblox policy interaction');
        }
      }

      clearDeleteState(session.state);
      await interaction.update(renderEditor(session.state));
    } catch (err) {
      await replyComponentError(interaction, err);
    }
  },
};

async function createSession(interaction) {
  const state = {
    id: generateSessionId(),
    ownerId: interaction.user.id,
    guildId: interaction.guildId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    pendingDelete: false,
    selectedIndex: null,
    draft: createEmptyDraft(),
    warning: '',
  };

  await refreshSessionData(state, interaction, { forceRoles: true });
  sessions.set(state.id, state);
  return state;
}

async function refreshSessionData(state, interaction, options = {}) {
  const roles = await getGroupRoles({ force: Boolean(options.forceRoles) });
  state.groupRoles = roles
    .slice()
    .sort((a, b) => Number(a.rank || 0) - Number(b.rank || 0));
  state.botRank = await getBotRank();
  state.assignableRanks = state.groupRoles.filter((role) => {
    const rank = Number(role?.rank);
    return Number.isFinite(rank) && rank > 0 && rank < 255 && (state.botRank === null || rank < state.botRank);
  });
  state.targetableRanks = state.assignableRanks.filter((role) => String(role?.id || '') !== MEMBER_ROBLOX_ROLE_ID);
  state.policies = getPoliciesFromConfig();
  state.selectedIndex = normalizeSelectedIndex(state.selectedIndex, state.policies.length);

  if (state.selectedIndex !== null && !state.draftDirty) {
    state.draft = policyToDraft(state.policies[state.selectedIndex], state.assignableRanks, state.targetableRanks);
  }

  state.roleNameMap = await getGuildRoleNameMap(interaction.guild);
  state.warning = buildWarning(state);
}

async function handleButtonAction(interaction, wrappedSession, startedAt) {
  const session = wrappedSession.state;
  let needsRefresh = false;
  let logAction = '';
  let logChange = '';
  switch (wrappedSession.action) {
    case 'new':
      session.selectedIndex = null;
      session.draft = createEmptyDraft();
      session.draftDirty = false;
      clearDeleteState(session);
      session.warning = buildWarning(session);
      break;
    case 'save':
      {
        const wasNew = session.selectedIndex === null;
        const beforePolicy = wasNew ? null : session.policies[session.selectedIndex];
        const savedPolicy = await saveDraft(session);
        logAction = wasNew ? 'policy-create' : 'policy-update';
        logChange = summarizePolicyChange(beforePolicy, savedPolicy, wasNew ? 'Created' : 'Updated');
      }
      break;
    case 'remove':
      if (session.selectedIndex === null) {
        throw new Error('Select a saved policy before removing it');
      }
      if (!session.pendingDelete) {
        session.pendingDelete = true;
        session.warning = 'Press Remove again to delete the selected policy.';
      } else {
        const removedPolicy = session.policies[session.selectedIndex] || null;
        removeSelectedPolicy(session);
        logAction = 'policy-delete';
        logChange = summarizePolicyChange(removedPolicy, null, 'Deleted');
      }
      break;
    case 'refresh':
      session.draftDirty = false;
      clearDeleteState(session);
      needsRefresh = true;
      break;
    default:
      throw new Error('Unsupported Roblox policy button action');
  }

  if (needsRefresh) {
    await refreshSessionData(session, interaction, { forceRoles: true });
  }

  touchSession(session);
  await interaction.update(renderEditor(session));
  if (logAction) {
    logPolicyAction(interaction, logAction, {
      startedAt,
      change: logChange,
    });
  }
}

function handlePickPolicy(interaction, session) {
  const index = Number.parseInt(interaction.values[0], 10);
  if (!Number.isSafeInteger(index) || index < 0 || index >= session.policies.length) {
    throw new Error('Selected policy no longer exists');
  }

  session.selectedIndex = index;
  session.draft = policyToDraft(session.policies[index], session.assignableRanks, session.targetableRanks);
  session.draftDirty = false;
  session.warning = buildWarning(session);
}

function handlePickRoles(interaction, session) {
  session.draft.discordRoleIds = [...new Set(interaction.values.map((value) => String(value).trim()).filter(Boolean))];
  session.draftDirty = true;
  session.warning = buildWarning(session);
}

function handlePickActions(interaction, session) {
  session.draft.actions = [...new Set(interaction.values.map((value) => String(value).trim()).filter(Boolean))];
  session.draftDirty = true;
  session.warning = buildWarning(session);
}

function handlePickTargetRoles(interaction, session, page) {
  session.draft.targetRoleIds = mergePagedRoleSelections(session, 'targetRoleIds', page, interaction.values);
  session.draftDirty = true;
  session.warning = buildWarning(session);
}

function handlePickAssignRoles(interaction, session, page) {
  session.draft.assignableRoleIds = mergePagedRoleSelections(session, 'assignableRoleIds', page, interaction.values);
  session.draftDirty = true;
  session.warning = buildWarning(session);
}

async function saveDraft(session) {
  validateDraft(session);

  const savedPolicy = {
    DISCORD_ROLE_IDS: session.draft.discordRoleIds.slice(),
    ACTIONS: session.draft.actions.slice(),
    TARGET_ROLE_IDS: filterPolicyRobloxRoleIds(session.draft.targetRoleIds, 'TARGET'),
    ASSIGNABLE_ROLE_IDS: session.draft.assignableRoleIds.slice(),
  };

  if (session.selectedIndex === null) {
    session.policies.push(savedPolicy);
    session.selectedIndex = session.policies.length - 1;
  } else {
    session.policies[session.selectedIndex] = savedPolicy;
  }

  persistPolicies(session.policies);
  session.draft = policyToDraft(savedPolicy, session.assignableRanks, session.targetableRanks);
  session.draftDirty = false;
  clearDeleteState(session);
  session.warning = 'Policy saved.';
  return savedPolicy;
}

function removeSelectedPolicy(session) {
  if (session.selectedIndex === null) {
    throw new Error('Select a saved policy before removing it');
  }

  session.policies.splice(session.selectedIndex, 1);
  persistPolicies(session.policies);
  session.selectedIndex = null;
  session.draft = createEmptyDraft();
  session.draftDirty = false;
  clearDeleteState(session);
  session.warning = 'Policy removed.';
}

function renderEditor(session) {
  const container = new ContainerBuilder()
    .setAccentColor(0x000000)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent('# Roblox Policy Editor <:admin:1499540189188718642>'),
      new TextDisplayBuilder().setContent(buildStatusMarkdown(session)),
    );

  appendSection(container, 'Saved Policy', 'Pick an existing policy or start a new one.', [
    buildPolicyPickerRow(session),
  ]);
  appendSection(container, 'Discord Roles', 'Choose which Discord roles receive this policy.', [
    buildRolePickerRow(session),
  ]);
  appendSection(container, 'Roblox Actions', 'Choose which Roblox commands this policy allows.', [
    buildActionPickerRow(session),
  ]);
  appendSection(container, 'Targetable Roblox Roles', 'These are the Roblox roles this policy can act on.', buildRoleMultiSelectRows(
    session,
    'target-roles',
    session.draft.targetRoleIds,
    'Targetable roles',
    session.targetableRanks,
  ));
  appendSection(container, 'Assignable Roblox Roles', 'These are the Roblox roles this policy can assign/remove.', buildRoleMultiSelectRows(
    session,
    'assign-roles',
    session.draft.assignableRoleIds,
    'Assignable roles',
  ));
  appendSection(container, 'Policy Actions', 'Save, remove, or refresh the current draft.', [
    buildActionButtonsRow(session),
  ]);

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
  };
}

function buildStatusMarkdown(session) {
  const selectedLabel = session.selectedIndex === null
    ? 'New policy'
    : `Editing policy ${session.selectedIndex + 1}/${session.policies.length}`;
  const botRole = session.botRank === null ? '`Unknown`' : `\`${getBotRoleDisplayName(session)}\``;
  const warning = session.warning ? `\n\n**${session.warning}**` : '';

  return [
    `### ${selectedLabel}`,
    `Bot role ceiling: ${botRole}`,
  ].join('\n') + warning;
}

function buildPolicyPickerRow(session) {
  const select = new StringSelectMenuBuilder()
    .setCustomId(buildCustomId(session.id, 'pick'))
    .setPlaceholder(session.policies.length > 0 ? 'Choose a saved policy to edit' : 'No saved policies yet')
    .setMinValues(1)
    .setMaxValues(1);

  if (session.policies.length === 0) {
    select.setDisabled(true).addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('No saved policies')
        .setValue('none'),
    );
  } else {
    select.addOptions(...session.policies.slice(0, MAX_SELECT_OPTIONS).map((policy, index) => {
      const option = new StringSelectMenuOptionBuilder()
        .setLabel(buildPolicyOptionLabel(session, policy, index))
        .setValue(String(index));
      if (session.selectedIndex === index) {
        option.setDefault(true);
      }
      return option;
    }));
  }

  return new ActionRowBuilder().addComponents(select);
}

function buildRolePickerRow(session) {
  const select = new RoleSelectMenuBuilder()
    .setCustomId(buildCustomId(session.id, 'roles'))
    .setPlaceholder('Select Discord roles for this policy')
    .setMinValues(1)
    .setMaxValues(25);

  if (session.draft.discordRoleIds.length > 0) {
    select.setDefaultRoles(...session.draft.discordRoleIds.slice(0, 25));
  }

  return new ActionRowBuilder().addComponents(select);
}

function buildActionPickerRow(session) {
  const select = new StringSelectMenuBuilder()
    .setCustomId(buildCustomId(session.id, 'actions'))
    .setPlaceholder('Select allowed Roblox actions')
    .setMinValues(1)
    .setMaxValues(ACTION_CHOICES.length)
    .addOptions(...ACTION_CHOICES.map((choice) => new StringSelectMenuOptionBuilder()
      .setLabel(choice.label)
      .setValue(choice.value)
      .setDefault(session.draft.actions.includes(choice.value))));

  return new ActionRowBuilder().addComponents(select);
}

function buildRoleMultiSelect(session, action, page, selectedRoleIds, placeholder, roles = session.assignableRanks) {
  const select = new StringSelectMenuBuilder()
    .setCustomId(buildCustomId(session.id, action))
    .setPlaceholder(placeholder)
    .setMinValues(0);

  const pageRoles = getRankPage(session, page, roles);
  const options = pageRoles.map((role) => new StringSelectMenuOptionBuilder()
    .setLabel(buildRankOptionLabel(role))
    .setValue(String(role.id))
    .setDefault(selectedRoleIds.includes(String(role.id))));

  if (options.length === 0) {
    select.setDisabled(true).addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel(session.botRank === null ? 'Set ROBLOX.BOT_USER_ID to load ranks' : 'No Roblox roles available')
        .setValue('0'),
    );
  } else {
    select.setMaxValues(options.length);
    select.addOptions(...options);
  }

  return select;
}

function buildRoleMultiSelectRows(
  session,
  actionPrefix,
  selectedRoleIds,
  labelPrefix,
  roles = session.assignableRanks,
) {
  const pageCount = getRankPageCount(session, roles);
  const rows = [];

  for (let page = 0; page < pageCount; page += 1) {
    const suffix = pageCount > 1 ? ` ${page + 1}/${pageCount}` : '';
    rows.push(new ActionRowBuilder().addComponents(
      buildRoleMultiSelect(
        session,
        `${actionPrefix}-${page}`,
        page,
        selectedRoleIds,
        `${labelPrefix}${suffix}`,
        roles,
      ),
    ));
  }

  return rows;
}

function buildActionButtonsRow(session) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(buildCustomId(session.id, 'new'))
      .setLabel('New')
      .setEmoji('<:new:1499538026240540702>')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(buildCustomId(session.id, 'save'))
      .setLabel('Save')
      .setEmoji('<:save:1499537972926742689>')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!isDraftSaveable(session)),
    new ButtonBuilder()
      .setCustomId(buildCustomId(session.id, 'remove'))
      .setLabel(session.pendingDelete ? 'Confirm Remove' : 'Remove')
      .setEmoji('<:delete:1499538866661752852>')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(session.selectedIndex === null),
    new ButtonBuilder()
      .setCustomId(buildCustomId(session.id, 'refresh'))
      .setEmoji('<:refresh:1499538053197463695>')
      .setLabel('Refresh')
      .setStyle(ButtonStyle.Secondary),
  );
}

function buildCustomId(sessionId, action) {
  return `${SESSION_PREFIX}:${sessionId}:${action}`;
}

function getPagedActionIndex(action, prefix) {
  const page = Number.parseInt(String(action).slice(prefix.length), 10);
  return Number.isSafeInteger(page) && page >= 0 ? page : 0;
}

function getSessionFromCustomId(customId) {
  const [prefix, sessionId, action] = String(customId || '').split(':');
  if (prefix !== SESSION_PREFIX || !sessionId || !action) {
    throw new Error('Unknown Roblox policy session');
  }

  pruneExpiredSessions();
  const state = sessions.get(sessionId);
  if (!state) {
    throw new Error('This Roblox policy session expired. Run /roblox-policy again.');
  }

  return {
    state,
    action,
  };
}

function assertAdministrator(interaction) {
  if (!isCommandPermissionAdmin(interaction)) {
    throw new Error('This command is restricted to Discord administrators');
  }
}

function assertSessionOwner(session, userId) {
  if (session.ownerId !== userId) {
    throw new Error('This Roblox policy session belongs to another user');
  }
}

function touchSession(session) {
  session.updatedAt = Date.now();
}

function pruneExpiredSessions() {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.updatedAt > SESSION_TTL_MS) {
      sessions.delete(sessionId);
    }
  }
}

function createEmptyDraft() {
  return {
    discordRoleIds: [],
    actions: [],
    targetRoleIds: [],
    assignableRoleIds: [],
  };
}

function policyToDraft(policy, availableRoles = [], targetRoles = availableRoles) {
  return {
    discordRoleIds: getPolicyRoleIds(policy),
    actions: normalizePolicyActions(policy.ACTIONS),
    targetRoleIds: getPolicyRobloxRoleIds(policy, 'TARGET', targetRoles),
    assignableRoleIds: getPolicyRobloxRoleIds(policy, 'ASSIGNABLE', availableRoles),
  };
}

function getPoliciesFromConfig() {
  const policies = Array.isArray(config.ROBLOX?.PERMISSIONS?.ROLE_POLICIES)
    ? config.ROBLOX.PERMISSIONS.ROLE_POLICIES
    : [];
  return policies.map((policy) => ({
    DISCORD_ROLE_IDS: getPolicyRoleIds(policy),
    ACTIONS: normalizePolicyActions(policy.ACTIONS),
    TARGET_ROLE_IDS: getExplicitPolicyRobloxRoleIds(policy, 'TARGET'),
    ASSIGNABLE_ROLE_IDS: getExplicitPolicyRobloxRoleIds(policy, 'ASSIGNABLE'),
  }));
}

function persistPolicies(policies) {
  config.ROBLOX.PERMISSIONS.ROLE_POLICIES = policies.map((policy) => ({
    DISCORD_ROLE_IDS: policy.DISCORD_ROLE_IDS.slice(),
    ACTIONS: policy.ACTIONS.slice(),
    TARGET_ROLE_IDS: filterPolicyRobloxRoleIds(policy.TARGET_ROLE_IDS, 'TARGET'),
    ASSIGNABLE_ROLE_IDS: policy.ASSIGNABLE_ROLE_IDS.slice(),
  }));

  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 4)}\n`, 'utf8');
}

function getPolicyRoleIds(policy) {
  return [...new Set(toStringArray(policy.DISCORD_ROLE_IDS))];
}

function getExplicitPolicyRobloxRoleIds(policy, policyType) {
  const key = policyType === 'TARGET' ? 'TARGET_ROLE_IDS' : 'ASSIGNABLE_ROLE_IDS';
  const roleIds = toStringArray(policy?.[key]);
  return filterPolicyRobloxRoleIds([...new Set(roleIds)], policyType);
}

function normalizePolicyActions(value) {
  const actions = [];
  for (const action of toStringArray(value)) {
    for (const resolvedAction of expandPolicyAction(action)) {
      if (SUPPORTED_ACTIONS.has(resolvedAction)) {
        actions.push(resolvedAction);
      }
    }
  }
  return [...new Set(actions)];
}

function expandPolicyAction(action) {
  return ACTION_ALIASES[action] || [action];
}

function getPolicyRobloxRoleIds(policy, policyType, availableRoles = []) {
  const explicitRoleIds = getExplicitPolicyRobloxRoleIds(policy, policyType);
  if (explicitRoleIds.length > 0) {
    const safeExplicitRoleIds = filterPolicyRobloxRoleIds(explicitRoleIds, policyType);
    if (availableRoles.length === 0) {
      return safeExplicitRoleIds;
    }

    const allowedRoleIds = new Set(availableRoles.map((role) => String(role?.id || '')));
    return safeExplicitRoleIds.filter((roleId) => allowedRoleIds.has(roleId));
  }

  return [];
}

function filterPolicyRobloxRoleIds(roleIds, policyType) {
  if (policyType !== 'TARGET') {
    return roleIds;
  }
  return roleIds.filter((roleId) => roleId !== MEMBER_ROBLOX_ROLE_ID);
}

async function getBotRank() {
  const botUserId = String(config.ROBLOX?.BOT_USER_ID || '').trim();
  if (!/^\d+$/.test(botUserId)) {
    return null;
  }
  return getRobloxApi().getUserGroupRank(getGroupId(), botUserId);
}

async function getGuildRoleNameMap(guild) {
  const map = new Map();
  if (!guild) {
    return map;
  }

  await guild.roles.fetch().catch((err) => {
    logCaughtError('Caught Discord role list fetch error', err);
    return null;
  });
  for (const [roleId, role] of guild.roles.cache) {
    map.set(roleId, role.name);
  }
  return map;
}

function normalizeSelectedIndex(index, length) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= length) {
    return null;
  }
  return index;
}

function buildWarning(session) {
  if (session.pendingDelete) {
    return 'Pending delete confirmation.';
  }

  if (session.botRank === null) {
    return 'Set ROBLOX.BOT_USER_ID to the bot account user ID so Roblox roles can be selected below the bot role.';
  }

  if (session.assignableRanks.length === 0) {
    return 'No Roblox roles are available below the bot rank.';
  }

  return '';
}

function logPolicyAction(interaction, action, options = {}) {
  logCommandAction(interaction, {
    action,
    commandName: 'roblox-policy',
    status: options.status || 'success',
    startedAt: options.startedAt,
    fields: buildPolicyLogFields(options.change),
  });
}

function buildPolicyLogFields(change) {
  return [
    { name: 'Changed', value: change || 'unknown', inline: false },
  ];
}

function summarizePolicyForLog(policy) {
  return [
    `Discord roles: ${summarizeList(getPolicyRoleIds(policy))}`,
    `Actions: ${summarizeList(policy.ACTIONS)}`,
    `Target Roblox roles: ${summarizeList(getExplicitPolicyRobloxRoleIds(policy, 'TARGET'))}`,
    `Assignable Roblox roles: ${summarizeList(getExplicitPolicyRobloxRoleIds(policy, 'ASSIGNABLE'))}`,
  ].join('\n');
}

function summarizePolicyChange(beforePolicy, afterPolicy, verb) {
  if (!beforePolicy && afterPolicy) {
    return `${verb} policy\n${summarizePolicyForLog(afterPolicy)}`;
  }

  if (beforePolicy && !afterPolicy) {
    return `${verb} policy\n${summarizePolicyForLog(beforePolicy)}`;
  }

  const changes = [];
  appendPolicyFieldChange(changes, 'Discord roles', getPolicyRoleIds(beforePolicy), getPolicyRoleIds(afterPolicy));
  appendPolicyFieldChange(changes, 'Actions', beforePolicy?.ACTIONS, afterPolicy?.ACTIONS);
  appendPolicyFieldChange(
    changes,
    'Target Roblox roles',
    getExplicitPolicyRobloxRoleIds(beforePolicy, 'TARGET'),
    getExplicitPolicyRobloxRoleIds(afterPolicy, 'TARGET'),
  );
  appendPolicyFieldChange(
    changes,
    'Assignable Roblox roles',
    getExplicitPolicyRobloxRoleIds(beforePolicy, 'ASSIGNABLE'),
    getExplicitPolicyRobloxRoleIds(afterPolicy, 'ASSIGNABLE'),
  );

  return changes.length > 0 ? `${verb} policy\n${changes.join('\n')}` : `${verb} policy without changes`;
}

function appendPolicyFieldChange(changes, label, beforeValue, afterValue) {
  const beforeText = summarizeList(beforeValue);
  const afterText = summarizeList(afterValue);
  if (beforeText !== afterText) {
    changes.push(`${label}: ${beforeText} -> ${afterText}`);
  }
}

function summarizeList(values) {
  const list = toStringArray(values);
  if (list.length === 0) {
    return 'none';
  }
  return list.join(', ');
}

function clearDeleteState(session) {
  session.pendingDelete = false;
}

function getRankPageCount(session, roles = session.assignableRanks) {
  return Math.max(1, Math.ceil(roles.length / MAX_SELECT_OPTIONS));
}

function getRankPage(session, page, roles = session.assignableRanks) {
  const start = page * MAX_SELECT_OPTIONS;
  return roles.slice(start, start + MAX_SELECT_OPTIONS);
}

function buildPolicyOptionLabel(session, policy, index) {
  const draft = policyToDraft(policy, session.assignableRanks, session.targetableRanks);
  const roleNames = getPolicyRoleIds(policy)
    .slice(0, 2)
    .map((roleId) => getRoleDisplayName(session, roleId))
    .join(', ');
  const actionCount = toStringArray(policy.ACTIONS).length;
  const label = `${index + 1}. ${roleNames || 'No roles'} | ${actionCount} act | T${draft.targetRoleIds.length} A${draft.assignableRoleIds.length}`;
  return label.length <= 100 ? label : label.slice(0, 100);
}

function getRoleDisplayName(session, roleId) {
  return session.roleNameMap.get(String(roleId)) || roleId;
}

function buildRankOptionLabel(role) {
  const label = String(role?.name || 'Unnamed role').trim() || 'Unnamed role';
  return label.length <= 100 ? label : label.slice(0, 100);
}

function getBotRoleDisplayName(session) {
  const role = session.groupRoles.find((entry) => Number(entry?.rank) === Number(session.botRank));
  return role?.name || 'Unknown role';
}

function appendSection(container, title, description, rows) {
  container.addSeparatorComponents(
    new SeparatorBuilder()
      .setSpacing(SeparatorSpacingSize.Small)
      .setDivider(true),
  );
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`### ${title}`),
    new TextDisplayBuilder().setContent(description),
  );
  for (const row of rows) {
    container.addActionRowComponents(row);
  }
}

function mergePagedRoleSelections(session, fieldName, page, selectedValues) {
  const roles = getDraftRoleChoices(session, fieldName);
  const pageRoleIds = new Set(getRankPage(session, page, roles).map((role) => String(role.id)));
  const safeValues = Array.isArray(selectedValues) ? selectedValues : [];
  const selectedRoleIds = [
    ...new Set(
      safeValues
        .map((value) => String(value).trim())
        .filter((value) => pageRoleIds.has(value)),
    ),
  ];
  const combinedSelections = new Set(
    session.draft[fieldName]
      .filter((roleId) => !pageRoleIds.has(roleId))
      .concat(selectedRoleIds),
  );

  return roles
    .filter((role) => combinedSelections.has(String(role.id)))
    .map((role) => String(role.id));
}

function getDraftRoleChoices(session, fieldName) {
  return fieldName === 'targetRoleIds' ? session.targetableRanks : session.assignableRanks;
}

function validateDraft(session) {
  if (session.draft.discordRoleIds.length === 0) {
    throw new Error('Select at least one Discord role');
  }
  if (session.draft.actions.length === 0) {
    throw new Error('Select at least one allowed action');
  }
  if (session.draft.targetRoleIds.length === 0) {
    throw new Error('Select at least one target Roblox role');
  }
  if (session.draft.assignableRoleIds.length === 0) {
    throw new Error('Select at least one assignable Roblox role');
  }

  const targetRoleIds = new Set(session.targetableRanks.map((role) => String(role.id)));
  const assignableRoleIds = new Set(session.assignableRanks.map((role) => String(role.id)));
  if (
    session.draft.targetRoleIds.some((roleId) => !targetRoleIds.has(roleId)) ||
    session.draft.assignableRoleIds.some((roleId) => !assignableRoleIds.has(roleId))
  ) {
    throw new Error('Selected Roblox roles must be below the bot rank');
  }
}

function isDraftSaveable(session) {
  try {
    validateDraft(session);
    return true;
  } catch {
    return false;
  }
}

function generateSessionId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function toStringArray(value) {
  return Array.isArray(value)
    ? value.map((entry) => String(entry).trim()).filter(Boolean)
    : [];
}

async function replyComponentError(interaction, err) {
  logCaughtError('Caught roblox-policy component error', err);

  const content = `Error: ${err?.message || String(err)}`;
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content }).catch((replyErr) => {
      logCaughtError('Caught roblox-policy component error response failure', replyErr);
    });
    return;
  }

  if (typeof interaction.reply === 'function') {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch((replyErr) => {
      logCaughtError('Caught roblox-policy component error response failure', replyErr);
    });
  }
}
