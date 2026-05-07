'use strict';

const LoggerClass = require('../../api/logger');
const logger = new LoggerClass('LevelUpHandler', 'BOT');

/**
 * Normalizes a Discord user id.
 * @param {*} value - Input value.
 * @returns {string} Normalized Discord id or empty string.
 */
function normalizeDiscordId(value) {
  const discordId = String(value ?? '').trim();
  if (!/^\d+$/.test(discordId)) {
    return '';
  }

  return discordId;
}

/**
 * Extracts a Discord user id from mention syntax.
 * @param {*} value - Input value.
 * @returns {string} Normalized Discord id or empty string.
 */
function extractDiscordIdFromMention(value) {
  const text = String(value ?? '').trim();
  const match = /^<@!?(\d+)>$/.exec(text);
  if (!match) {
    return '';
  }

  return normalizeDiscordId(match[1]);
}

/**
 * Extracts the reached level from the description.
 * @param {string} description
 * @returns {number|null} The reached level or null if not found.
 */
function extractReachedLevel(description) {
  const match = description.match(/reached\s+\*{0,2}level\s+(\d+)\*{0,2}/i);
  return match ? Number(match[1]) : null;
}

/**
 * @param {import('discord.js').Message} message
 */
module.exports = async function levelUpHandler(message) {
  const sourceMessage = message?.messageSnapshots?.first?.() ?? message;
  if (!sourceMessage) {
    return;
  }

  const content = typeof sourceMessage.content === 'string' ? sourceMessage.content : '';
  const embeds = Array.isArray(sourceMessage.embeds) ? sourceMessage.embeds : [];

  if (!content) {
    return;
  }

  if (!embeds || embeds.length === 0) {
    return;
  }

  const embed = embeds[0];
  if (!embed) {
    return;
  }

  if (!embed.title || !embed.title.includes('Level Up!')) {
    return;
  }

  const description = embed.description;
  if (!description) {
    return;
  }

  const levelReached = extractReachedLevel(description);
  if (!levelReached) {
    return;
  }

  const levelUpDiscordId = extractDiscordIdFromMention(content);

  if (!levelUpDiscordId) {
    return;
  }

  // TODO: Do something with the extracted information
  logger.info(`User ${levelUpDiscordId} reached level ${levelReached}`);
};
