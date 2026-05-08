'use strict';

const config = require('../../../config.json');

const LoggerClass = require('../../api/logger');
const logger = new LoggerClass('ReadyHandler', 'BOT');

/**
 * @param {import('discord.js').Client} client
 */
module.exports = async function readyHandler(client) {
  let guild = client.guilds.cache.get(config.DISCORD.BOT.GUILD_ID);
  if (!guild) {
    try {
      guild = await client.guilds.fetch(config.DISCORD.BOT.GUILD_ID);
    } catch (err) {
      logger.error('Failed to fetch configured guild:', err);
    }
  }

  if (!guild) {
    logger.error('Guild not found in cache or fetch. Check DISCORD.BOT.GUILD_ID in config.json');
    return;
  }

  logger.info(`Ready. Logged in as ${ client.user?.tag || 'unknown'}`);
};
