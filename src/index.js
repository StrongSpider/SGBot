'use strict';

const { Client, Collection, GatewayIntentBits, Partials } = require('discord.js');
const path = require('path');
const fs = require('fs');

const LoggerClass = require('./api/logger');
const logger = new LoggerClass('Index', 'BOT');

const config = require('../config.json');
const BOT_TOKEN = config.DISCORD.BOT.TOKEN;

if (!BOT_TOKEN || typeof BOT_TOKEN !== 'string' || BOT_TOKEN.trim().length === 0) {
  logger.error('DISCORD.BOT.TOKEN is missing in config.json');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.GuildMember,
    Partials.User,
  ],
});

// Commands collection exposed to handlers
client.commands = new Collection();

/**
 * Load all command modules from ./commands
 * Expects each file to export { data: SlashCommandBuilder, execute: Function }
 */
function loadCommands() {
  const commandsDir = path.join(__dirname, 'commands');
  let count = 0;
  try {
    const files = fs.readdirSync(commandsDir).filter((f) => f.endsWith('.js'));
    for (const file of files) {
      const filePath = path.join(commandsDir, file);
      try {
        const mod = require(filePath);
        if (mod && mod.data && typeof mod.data.name === 'string' && typeof mod.execute === 'function') {
          client.commands.set(mod.data.name, mod);
          count++;
        } else {
          logger.warn(`Command file missing data or execute: ${ filePath}`);
        }
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        logger.error(`Failed to load command ${ filePath } - ${ msg}`);
      }
    }
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    logger.error(`Failed to scan commands directory: ${ msg}`);
  }
  logger.info(`Loaded commands: ${ count}`);
}

/**
 * Load all event handlers from ./events/<eventName>/*.js
 * Registers one listener per event that calls each handler in order.
 */
function loadEventHandlers() {
  const eventsRoot = path.join(__dirname, 'events');
  let totalEvents = 0;
  try {
    const entries = fs.readdirSync(eventsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const eventName = entry.name;
      const folderPath = path.join(eventsRoot, eventName);

      let handlers = [];
      try {
        const files = fs.readdirSync(folderPath).filter((f) => f.endsWith('.js'));
        handlers = files.map((file) => {
          const filePath = path.join(folderPath, file);
          try {
            const fn = require(filePath);
            if (typeof fn === 'function') return fn;
            logger.warn(`Event file does not export a function: ${ filePath}`);
            return null;
          } catch (e) {
            const msg = e && e.message ? e.message : String(e);
            logger.error(`Failed to load event file ${ filePath } - ${ msg}`);
            return null;
          }
        }).filter(Boolean);
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        logger.error(`Failed to read event folder ${ folderPath } - ${ msg}`);
        handlers = [];
      }

      if (handlers.length === 0) continue;

      client.on(eventName, async (...args) => {
        for (const handler of handlers) {
          try { await handler(...args); } catch (e) {
            const msg = e && e.message ? e.message : String(e);
            logger.error(`Event handler for ${ eventName } threw: ${ msg}`);
          }
        }
      });

      totalEvents += handlers.length;
    }
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    logger.error(`Failed to scan events directory: ${ msg}`);
  }
  logger.info(`Loaded event handlers: ${ totalEvents}`);
}

// Bootstrap
loadCommands();
loadEventHandlers();

client.login(BOT_TOKEN);
