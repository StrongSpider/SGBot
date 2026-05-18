'use strict';

const fs = require('fs/promises');
const path = require('path');

const COMMAND_USAGE_FILE_PATH = path.resolve(__dirname, '../data/command-usage.json');
const STORE_VERSION = 1;

let writeQueue = Promise.resolve();

async function recordSuccessfulCommandUsage(interaction, commandNameInput = '') {
  const userId = normalizeSnowflake(interaction?.user?.id);
  const commandName = normalizeCommandName(commandNameInput || interaction?.commandName);
  if (!userId || !commandName) {
    return;
  }

  const usedAt = new Date();
  const write = writeQueue
    .catch(() => {})
    .then(async () => {
      const store = await readUsageStore();
      const userStats = getOrCreateUserStats(store, userId);
      const commandStats = getOrCreateCommandStats(userStats, commandName);
      const dateKey = formatUtcDateKey(usedAt);

      commandStats.allTime = toSafeCount(commandStats.allTime) + 1;
      commandStats.days[dateKey] = toSafeCount(commandStats.days[dateKey]) + 1;
      commandStats.lastUsedAt = usedAt.toISOString();

      await writeUsageStore(store);
    });

  writeQueue = write;
  return write;
}

async function getUserCommandUsage(userIdInput, nowInput = new Date()) {
  const userId = normalizeSnowflake(userIdInput);
  const now = toDate(nowInput);
  const monthStart = getUtcMonthStart(now);
  const weekStart = getUtcWeekStart(now);
  const store = await readUsageStore();
  const userStats = userId ? store.users[userId] : null;
  const commands = [];

  if (userStats?.commands && typeof userStats.commands === 'object') {
    for (const [commandName, commandStats] of Object.entries(userStats.commands)) {
      const normalizedCommandName = normalizeCommandName(commandName);
      if (!normalizedCommandName) {
        continue;
      }

      const entry = buildCommandUsageEntry(normalizedCommandName, commandStats, monthStart, weekStart);
      if (entry.allTime > 0) {
        commands.push(entry);
      }
    }
  }

  commands.sort((a, b) => {
    if (b.allTime !== a.allTime) {
      return b.allTime - a.allTime;
    }
    return a.commandName.localeCompare(b.commandName);
  });

  return {
    userId,
    commands,
    totals: commands.reduce((totals, entry) => ({
      allTime: totals.allTime + entry.allTime,
      monthly: totals.monthly + entry.monthly,
      weekly: totals.weekly + entry.weekly,
    }), { allTime: 0, monthly: 0, weekly: 0 }),
    monthStart: monthStart.toISOString(),
    weekStart: weekStart.toISOString(),
  };
}

function buildCommandUsageEntry(commandName, commandStats, monthStart, weekStart) {
  const days = commandStats?.days && typeof commandStats.days === 'object' ? commandStats.days : {};
  let monthly = 0;
  let weekly = 0;

  for (const [dateKey, countInput] of Object.entries(days)) {
    const day = parseUtcDateKey(dateKey);
    const count = toSafeCount(countInput);
    if (!day || count <= 0) {
      continue;
    }

    if (day >= monthStart) {
      monthly += count;
    }
    if (day >= weekStart) {
      weekly += count;
    }
  }

  return {
    commandName,
    allTime: toSafeCount(commandStats?.allTime),
    monthly,
    weekly,
    lastUsedAt: typeof commandStats?.lastUsedAt === 'string' ? commandStats.lastUsedAt : '',
  };
}

async function readUsageStore() {
  let raw = '';
  try {
    raw = await fs.readFile(COMMAND_USAGE_FILE_PATH, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return createEmptyStore();
    }
    throw err;
  }

  if (!raw.trim()) {
    return createEmptyStore();
  }

  return normalizeUsageStore(JSON.parse(raw));
}

async function writeUsageStore(store) {
  await fs.mkdir(path.dirname(COMMAND_USAGE_FILE_PATH), { recursive: true });
  const tempPath = `${COMMAND_USAGE_FILE_PATH}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(normalizeUsageStore(store), null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, COMMAND_USAGE_FILE_PATH);
}

function normalizeUsageStore(value) {
  const normalized = createEmptyStore();
  if (!value || typeof value !== 'object') {
    return normalized;
  }

  const users = value.users && typeof value.users === 'object' && !Array.isArray(value.users) ? value.users : {};
  for (const [userIdInput, userInput] of Object.entries(users)) {
    const userId = normalizeSnowflake(userIdInput);
    if (!userId || !userInput || typeof userInput !== 'object') {
      continue;
    }

    const userStats = getOrCreateUserStats(normalized, userId);
    const commands = userInput.commands && typeof userInput.commands === 'object' && !Array.isArray(userInput.commands) ?
      userInput.commands :
      {};

    for (const [commandNameInput, commandInput] of Object.entries(commands)) {
      const commandName = normalizeCommandName(commandNameInput);
      if (!commandName || !commandInput || typeof commandInput !== 'object') {
        continue;
      }

      const commandStats = getOrCreateCommandStats(userStats, commandName);
      commandStats.allTime = toSafeCount(commandInput.allTime);
      commandStats.lastUsedAt = typeof commandInput.lastUsedAt === 'string' ? commandInput.lastUsedAt : '';

      const days = commandInput.days && typeof commandInput.days === 'object' && !Array.isArray(commandInput.days) ?
        commandInput.days :
        {};
      for (const [dateKey, countInput] of Object.entries(days)) {
        if (parseUtcDateKey(dateKey)) {
          commandStats.days[dateKey] = toSafeCount(countInput);
        }
      }
    }
  }

  return normalized;
}

function createEmptyStore() {
  return {
    version: STORE_VERSION,
    users: {},
  };
}

function getOrCreateUserStats(store, userId) {
  if (!store.users[userId]) {
    store.users[userId] = { commands: {} };
  }
  return store.users[userId];
}

function getOrCreateCommandStats(userStats, commandName) {
  if (!userStats.commands[commandName]) {
    userStats.commands[commandName] = {
      allTime: 0,
      days: {},
      lastUsedAt: '',
    };
  }
  return userStats.commands[commandName];
}

function normalizeSnowflake(value) {
  const id = String(value || '').trim();
  return /^\d+$/.test(id) ? id : '';
}

function normalizeCommandName(value) {
  return String(value || '')
    .trim()
    .replace(/^\//, '')
    .toLowerCase();
}

function toSafeCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) {
    return 0;
  }
  return Math.floor(count);
}

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return new Date();
  }
  return date;
}

function getUtcMonthStart(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function getUtcWeekStart(date) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayOfWeek = start.getUTCDay();
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  start.setUTCDate(start.getUTCDate() - daysSinceMonday);
  return start;
}

function formatUtcDateKey(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseUtcDateKey(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

module.exports = {
  COMMAND_USAGE_FILE_PATH,
  getUserCommandUsage,
  recordSuccessfulCommandUsage,
};
