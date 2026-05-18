'use strict';

const {
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
} = require('discord.js');

const config = require('../../../config.json');
const restrictedGroups = require('../../../RESTRICTED_GROUPS.json');
const LoggerClass = require('../../api/logger');
const logger = new LoggerClass('RoleEligibility', 'BOT');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MINIMUM_ACCOUNT_AGE_DAYS = 30;
const DEFAULT_MINIMUM_BADGE_COUNT = 35;
const THEME_COLOR_FAILED = 0xff0000;
const THEME_COLOR_SUCCESS = 0x00aa00;
const ICON_PASSED = '<:yes:1501801374353068042>';
const ICON_FAILED = '<:no:1501801264256647298>';
const ADD_ROLE_ASSET_ENFORCED_NAMES = new Set(['full access', 'half access', '1 tap access']);

async function evaluateAddRoleEligibility(api, target, assignRole, groupId, targetRole = null) {
  const settings = getRequirementSettings();
  const roleRule = getAddRoleEnforcedRequirement(assignRole);
  const restrictedGroupIds = getRestrictedGroupIds();
  const userId = target.robloxId;

  const profilePromise = captureLookup(() => api.getUserDetailsById(userId));
  const badgesPromise = captureLookup(() => api.getUserBadgeCount(userId, {
    minimumCount: settings.minimumBadgeCount,
  }));
  const membershipsPromise = captureLookup(() => api.getUserGroupMemberships(userId));
  const nameSkipPromise = settings.nameSkipAssetId
    ? captureLookup(() => api.userOwnsAsset(userId, settings.nameSkipAssetId))
    : Promise.resolve({ ok: true, value: false });
  const roleAssetPromise = roleRule?.requiredAssetId
    ? captureLookup(() => api.userOwnsAsset(userId, roleRule.requiredAssetId))
    : Promise.resolve({ ok: true, value: null });

  const [
    profileResult,
    badgeResult,
    membershipsResult,
    nameSkipResult,
    roleAssetResult,
  ] = await Promise.all([
    profilePromise,
    badgesPromise,
    membershipsPromise,
    nameSkipPromise,
    roleAssetPromise,
  ]);

  const checks = [];
  checks.push(buildDisplayNameCheck(profileResult, nameSkipResult));
  checks.push(buildAccountAgeCheck(profileResult, settings.minimumAccountAgeDays));
  checks.push(buildBadgeCountCheck(badgeResult, settings.minimumBadgeCount));
  appendInventoryVisibilityCheck(checks, nameSkipResult, roleAssetResult);

  const memberships = membershipsResult.ok ? membershipsResult.value : [];
  checks.push(buildMainGroupCheck(membershipsResult, memberships, groupId, targetRole));
  checks.push(await buildRestrictedGroupsCheck(api, membershipsResult, memberships, restrictedGroupIds));

  if (roleRule) {
    checks.push(buildRoleAssetCheck(roleRule, roleAssetResult));
  }

  const failedChecks = checks.filter((check) => !check.passed);
  return {
    allowed: failedChecks.length === 0,
    checks,
    failedChecks,
    passedChecks: checks.filter((check) => check.passed),
    settings,
    roleRule,
  };
}

function createBypassedEligibilityResult() {
  const checks = [
    passCheck('Eligibility Checks', 'Bypassed'),
  ];
  return {
    allowed: true,
    bypassed: true,
    checks,
    failedChecks: [],
    passedChecks: checks,
    settings: getRequirementSettings(),
    roleRule: null,
  };
}

async function evaluateRequirementAssetOwnership(api, target) {
  const userId = target.robloxId;
  const items = await Promise.all(getRequirementAssetRules().map(async (asset) => {
    const result = await captureLookup(() => api.userOwnsAsset(userId, asset.assetId));
    const owned = result.ok && result.value === true;
    return {
      ...asset,
      owned,
      status: result.ok ? (owned ? 'owned' : 'missing') : getOwnershipFailureStatus(result),
      error: result.ok ? '' : result.error,
      reason: result.reason || '',
    };
  }));

  return {
    items,
    ownedItems: items.filter((item) => item.status === 'owned'),
    missingItems: items.filter((item) => item.status === 'missing'),
    failedItems: items.filter((item) => item.status === 'failed' || item.status === 'private'),
    privateItems: items.filter((item) => item.status === 'private'),
  };
}

function renderAddRoleEligibilityResponse({ target, role, result, title, summary }) {
  const failedChecks = result.failedChecks || [];
  const passedChecks = result.passedChecks || [];
  const totalChecks = result.checks.length;
  const container = new ContainerBuilder()
    .setAccentColor(THEME_COLOR_FAILED)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## ${title || 'Requirements Not Met <:no:1501801264256647298>'}`),
    );

  appendSeparator(container);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent([
      `**User:** ${inlineCode(target.label)}  **ID:** ${inlineCode(target.robloxId)}  **Role:** ${inlineCode(formatRoleName(role))}`,
      summary ? `**Status:** ${summary}` : '',
    ].filter(Boolean).join('\n')),
  );

  appendSeparator(container);
  if (failedChecks.length > 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(formatCheckSection(`Failed (${failedChecks.length}/${totalChecks})`, failedChecks, false)),
    );
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**Failed (0/${totalChecks}):**\n${inlineCode('None')}`),
    );
  }

  if (passedChecks.length > 0) {
    appendSeparator(container);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(formatCheckSection(`Passed (${passedChecks.length}/${totalChecks})`, passedChecks, true)),
    );
  }

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowedMentions: { parse: [] },
  };
}

function renderAddRoleCheckResponse({ target, result, shirts }) {
  const displayResult = withPrivateInventoryOwnershipCheck(result, shirts);
  const failedChecks = displayResult.failedChecks || [];
  const passedChecks = displayResult.passedChecks || [];
  const totalChecks = displayResult.checks.length;
  const allowed = failedChecks.length === 0;
  const container = new ContainerBuilder()
    .setAccentColor(allowed ? THEME_COLOR_SUCCESS : THEME_COLOR_FAILED)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## Add Role Requirements ${allowed ? `Met ${ICON_PASSED}` : `Not Met ${ICON_FAILED}`}`,
      ),
    );

  appendSeparator(container);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent([
      `**User:** ${inlineCode(target.label)}  **ID:** ${inlineCode(target.robloxId)}  **Status:** ${allowed ? 'Meets base add-role requirements' : 'Missing base add-role requirements'}`,
    ].join('\n')),
  );

  appendSeparator(container);
  if (failedChecks.length > 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(formatCheckSection(`Failed (${failedChecks.length}/${totalChecks})`, failedChecks, false)),
    );
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**Failed (0/${totalChecks}):**\n${inlineCode('None')}`),
    );
  }

  if (passedChecks.length > 0) {
    appendSeparator(container);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(formatCheckSection(`Passed (${passedChecks.length}/${totalChecks})`, passedChecks, true)),
    );
  }

  appendSeparator(container);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(formatShirtOwnershipSection(shirts)),
  );

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowedMentions: { parse: [] },
  };
}

function withPrivateInventoryOwnershipCheck(result, ownership) {
  const checks = Array.isArray(result?.checks) ? result.checks : [];
  if (!hasPrivateInventoryItems(ownership) || hasCheck(checks, 'Inventory Visibility')) {
    return result;
  }

  const nextChecks = [
    ...checks,
    failCheck('Inventory Visibility', 'Private inventory'),
  ];

  return {
    ...result,
    allowed: false,
    checks: nextChecks,
    failedChecks: nextChecks.filter((check) => !check.passed),
    passedChecks: nextChecks.filter((check) => check.passed),
  };
}

function hasPrivateInventoryItems(ownership) {
  const items = Array.isArray(ownership?.items) ? ownership.items : [];
  return items.some((item) => item.status === 'private' || item.reason === 'private-inventory');
}

function hasCheck(checks, label) {
  return checks.some((check) => check.label === label);
}

function buildEligibilityLogFields(result) {
  if (!result || !Array.isArray(result.checks)) {
    return [];
  }

  if (result.bypassed) {
    return [
      {
        name: 'Requirements',
        value: 'Bypassed by command option',
        inline: true,
      },
    ];
  }

  const failedChecks = result.checks.filter((check) => !check.passed);
  return [
    {
      name: 'Requirements',
      value: `${failedChecks.length} failed / ${result.checks.length} checked`,
      inline: true,
    },
    {
      name: 'Failed Checks',
      value: failedChecks.length > 0
        ? failedChecks.map((check) => `${check.label}: ${check.value}`).join('; ')
        : 'None',
      inline: false,
    },
  ];
}

function buildDisplayNameCheck(profileResult, nameSkipResult) {
  if (!profileResult.ok || !profileResult.value) {
    return failCheck('Display Name ("SG")', `Profile lookup failed: ${profileResult.error}`);
  }

  const displayName = String(profileResult.value.displayName || profileResult.value.name || '').trim();
  if (/sg/i.test(displayName)) {
    return passCheck('Display Name ("SG")', displayName || 'Has SG');
  }

  if (nameSkipResult.ok && nameSkipResult.value === true) {
    return passCheck('Display Name ("SG")', 'Name Skip owned');
  }

  if (!nameSkipResult.ok) {
    const detail = isPrivateInventoryLookup(nameSkipResult)
      ? 'inventory is private'
      : `name skip lookup failed: ${nameSkipResult.error}`;
    return failCheck('Display Name ("SG")', `Missing SG; ${detail}`);
  }

  return failCheck('Display Name ("SG")', 'Missing SG');
}

function buildAccountAgeCheck(profileResult, minimumDays) {
  if (!profileResult.ok || !profileResult.value) {
    return failCheck('Account Age', `Profile lookup failed: ${profileResult.error}`);
  }

  const createdAt = Date.parse(profileResult.value.created || '');
  if (!Number.isFinite(createdAt)) {
    return failCheck('Account Age', 'Unknown created date');
  }

  const ageDays = Math.max(0, Math.floor((Date.now() - createdAt) / DAY_MS));
  const value = `${ageDays}/${minimumDays} days`;
  return ageDays >= minimumDays
    ? passCheck('Account Age', value)
    : failCheck('Account Age', value);
}

function buildBadgeCountCheck(badgeResult, minimumCount) {
  if (!badgeResult.ok || !badgeResult.value) {
    return failCheck('Account Badges', `Badge lookup failed: ${badgeResult.error}`);
  }

  const badgeCount = Number(badgeResult.value.count);
  const displayCount = badgeResult.value.meetsMinimum && !badgeResult.value.complete
    ? `${minimumCount}+`
    : String(Number.isFinite(badgeCount) ? badgeCount : 0);
  const value = `${displayCount}/${minimumCount} badges`;
  return badgeResult.value.meetsMinimum
    ? passCheck('Account Badges', value)
    : failCheck('Account Badges', value);
}

function buildMainGroupCheck(membershipsResult, memberships, groupId, targetRole) {
  if (!membershipsResult.ok) {
    return failCheck('SG Group', `Group lookup failed: ${membershipsResult.error}`);
  }

  const safeGroupId = String(groupId || '').trim();
  const membership = memberships.find((entry) => String(entry?.group?.id || '') === safeGroupId);
  if (!membership) {
    return failCheck('SG Group', 'Not a member');
  }

  return passCheck('SG Group', formatRoleName(membership.role || targetRole || { name: 'Member' }));
}

async function buildRestrictedGroupsCheck(api, membershipsResult, memberships, restrictedGroupIds) {
  if (!membershipsResult.ok) {
    return failCheck('Restricted Groups', `Group lookup failed: ${membershipsResult.error}`);
  }

  const restrictedSet = new Set(restrictedGroupIds);
  const matches = memberships.filter((entry) => restrictedSet.has(String(entry?.group?.id || '')));
  if (matches.length === 0) {
    return passCheck('Restricted Groups', 'Clear');
  }

  const names = await Promise.all(matches.map((match) => getRestrictedGroupName(api, match)));
  return failCheck('Restricted Groups', names.join(', '));
}

function buildRoleAssetCheck(roleRule, roleAssetResult) {
  const label = `${roleRule.name} Merch`;
  if (!roleAssetResult.ok) {
    return failCheck(label, isPrivateInventoryLookup(roleAssetResult)
      ? 'Inventory is private'
      : `Ownership lookup failed: ${roleAssetResult.error}`);
  }

  return roleAssetResult.value === true
    ? passCheck(label, 'Owned')
    : failCheck(label, 'Not owned');
}

function formatShirtOwnershipSection(ownership) {
  const items = Array.isArray(ownership?.items) ? ownership.items : [];
  const ownedItems = items.filter((item) => item.status === 'owned');
  const missingItems = items.filter((item) => item.status === 'missing');
  const failedItems = items.filter((item) => item.status === 'failed');
  const privateItems = items.filter((item) => item.status === 'private');
  const lines = ['**Shirts:**'];

  if (items.length === 0) {
    lines.push(inlineCode('No shirts configured'));
    return lines.join('\n');
  }

  if (ownedItems.length === 0 && failedItems.length === 0 && privateItems.length === 0) {
    lines.push(`${ICON_FAILED} **User owns no shirts**`);
    return lines.join('\n');
  }

  for (const item of ownedItems) {
    lines.push(`${ICON_PASSED} **${item.name}:** ${inlineCode('Owned')}`);
  }

  for (const item of missingItems) {
    lines.push(`${ICON_FAILED} **${item.name}:** ${inlineCode('Not owned')}`);
  }

  for (const item of privateItems) {
    lines.push(`${ICON_FAILED} **${item.name}:** ${inlineCode('Private inventory')}`);
  }

  for (const item of failedItems) {
    lines.push(`${ICON_FAILED} **${item.name}:** ${inlineCode(`Lookup failed: ${item.error}`)}`);
  }

  return lines.join('\n');
}

async function getRestrictedGroupName(api, membership) {
  const groupId = String(membership?.group?.id || '').trim();
  try {
    const name = await api.getGroupName(groupId);
    if (name) {
      return name;
    }
  } catch (err) {
    logger.error('Caught restricted group name lookup error:', err);
  }

  return String(membership?.group?.name || groupId || 'Unknown group').trim();
}

function getRequirementSettings() {
  const raw = config.ROBLOX?.ROLE_REQUIREMENTS || {};
  return {
    minimumAccountAgeDays: normalizePositiveInteger(
      raw.minimumAccountAgeDays,
      DEFAULT_MINIMUM_ACCOUNT_AGE_DAYS,
    ),
    minimumBadgeCount: normalizePositiveInteger(
      raw.minimumBadgeCount,
      DEFAULT_MINIMUM_BADGE_COUNT,
    ),
    nameSkipAssetId: normalizeOptionalId(raw.nameSkipAssetId),
    nameSkipUrl: String(raw.nameSkipUrl || '').trim(),
  };
}

function getRuledRoleRequirement(assignRole) {
  const roleId = String(assignRole?.id || '').trim();
  const raw = config.ROBLOX?.RULED_ROLES?.[roleId];
  if (!raw) {
    return null;
  }

  if (typeof raw !== 'object') {
    return null;
  }

  return {
    roleId,
    name: String(raw.name || formatRoleName(assignRole)).trim() || formatRoleName(assignRole),
    requiredAssetId: normalizeOptionalId(raw.requiredAssetId),
    url: String(raw.url || '').trim(),
  };
}

function getAddRoleEnforcedRequirement(assignRole) {
  const roleRule = getRuledRoleRequirement(assignRole);
  if (!roleRule || !ADD_ROLE_ASSET_ENFORCED_NAMES.has(normalizeRequirementName(roleRule.name))) {
    return null;
  }

  return roleRule;
}

function getRequirementAssetRules() {
  const assets = [];
  const settings = getRequirementSettings();
  if (settings.nameSkipAssetId) {
    assets.push({
      type: 'name-skip',
      key: `name-skip:${settings.nameSkipAssetId}`,
      name: 'Name Skip',
      assetId: settings.nameSkipAssetId,
      url: settings.nameSkipUrl,
    });
  }

  const ruledRoles = config.ROBLOX?.RULED_ROLES || {};
  for (const [roleId, raw] of Object.entries(ruledRoles)) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }

    const assetId = normalizeOptionalId(raw.requiredAssetId);
    if (!assetId) {
      continue;
    }

    const roleName = String(raw.name || `Role ${roleId}`).trim() || `Role ${roleId}`;
    assets.push({
      type: 'role',
      key: `role:${roleId}:${assetId}`,
      roleId,
      name: formatMerchName(roleName),
      assetId,
      url: String(raw.url || '').trim(),
    });
  }

  return assets;
}

function getRestrictedGroupIds() {
  return (Array.isArray(restrictedGroups) ? restrictedGroups : [])
    .map((entry) => {
      if (entry && typeof entry === 'object') {
        return String(entry.id || entry.groupId || '').trim();
      }
      return String(entry || '').trim();
    })
    .filter((value, index, values) => /^\d+$/.test(value) && values.indexOf(value) === index);
}

async function captureLookup(fn) {
  try {
    return {
      ok: true,
      value: await fn(),
    };
  } catch (err) {
    logger.error('Caught Roblox eligibility lookup error:', err);
    return {
      ok: false,
      error: formatLookupError(err),
      reason: getLookupFailureReason(err),
    };
  }
}

function appendInventoryVisibilityCheck(checks, ...results) {
  if (!results.some(isPrivateInventoryLookup)) {
    return;
  }

  checks.push(failCheck('Inventory Visibility', 'Private inventory'));
}

function getOwnershipFailureStatus(result) {
  return isPrivateInventoryLookup(result) ? 'private' : 'failed';
}

function isPrivateInventoryLookup(result) {
  return result?.reason === 'private-inventory';
}

function passCheck(label, value) {
  return {
    label,
    value: String(value || 'Passed'),
    passed: true,
  };
}

function failCheck(label, value) {
  return {
    label,
    value: String(value || 'Failed'),
    passed: false,
  };
}

function formatCheckSection(title, checks, passed) {
  return [
    `**${title}:**`,
    ...checks.map((check) => `${passed ? ICON_PASSED : ICON_FAILED} **${check.label}:** ${inlineCode(check.value)}`),
  ].join('\n');
}

function appendSeparator(container) {
  container.addSeparatorComponents(
    new SeparatorBuilder()
      .setSpacing(SeparatorSpacingSize.Small)
      .setDivider(true),
  );
}

function inlineCode(value) {
  const text = String(value ?? '').replace(/`/g, "'").trim() || 'unknown';
  return `\`${text.length <= 120 ? text : `${text.slice(0, 117)}...`}\``;
}

function formatRoleName(role) {
  return String(role?.name || role?.displayName || 'Unnamed role').trim() || 'Unnamed role';
}

function formatMerchName(name) {
  const label = String(name || '').trim();
  if (!label) {
    return 'Merch';
  }
  return /merch$/i.test(label) ? label : `${label} Merch`;
}

function formatLookupError(err) {
  const message = String(err?.message || err || 'unknown error')
    .replace(/\s+/g, ' ')
    .trim();
  return message.length <= 120 ? message : `${message.slice(0, 117)}...`;
}

function getLookupFailureReason(err) {
  if (isPrivateInventoryError(err)) {
    return 'private-inventory';
  }
  return '';
}

function isPrivateInventoryError(err) {
  const operation = String(err?.operation || '').toLowerCase();
  const status = Number(err?.status);
  const detail = [
    err?.message,
    ...getErrorBodyMessages(err?.body),
  ].join(' ').toLowerCase();

  return operation === 'inventory.userownsasset' &&
    status === 403 &&
    /private|forbidden|permission|not authorized|not allowed|cannot view|can't view|access denied/.test(detail);
}

function getErrorBodyMessages(body) {
  if (!body) {
    return [];
  }

  if (typeof body === 'string') {
    return [body];
  }

  if (Array.isArray(body.errors)) {
    return body.errors
      .flatMap((entry) => [
        entry?.message,
        entry?.userFacingMessage,
        entry?.code,
      ])
      .filter(Boolean)
      .map((value) => String(value));
  }

  return [JSON.stringify(body)];
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.trunc(parsed);
}

function normalizeOptionalId(value) {
  const id = String(value || '').trim();
  return /^\d+$/.test(id) ? id : '';
}

function normalizeRequirementName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

module.exports = {
  buildEligibilityLogFields,
  createBypassedEligibilityResult,
  evaluateAddRoleEligibility,
  evaluateRequirementAssetOwnership,
  renderAddRoleCheckResponse,
  renderAddRoleEligibilityResponse,
};
