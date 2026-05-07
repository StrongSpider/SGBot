const { REST, Routes } = require('discord.js');
const config = require('../config.json');

const fs = require('node:fs');
const path = require('node:path');

const LoggerClass = require('./api/logger');
const logger = new LoggerClass('Deploy', 'BOT');

const deployOptions = getDeployOptions(process.argv.slice(2));
const commands = [];

// Grab all the command folders from the commands directory you created earlier
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter((file) => file.endsWith('.js'));
// Grab the SlashCommandBuilder#toJSON() output of each command's data for deployment
for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  const command = require(filePath);
  if ('data' in command && 'execute' in command) {
    commands.push(command.data.toJSON());
  } else {
    logger.warn(`The command at ${filePath} is missing a required "data" or "execute" property.`);
  }
}

// Construct and prepare an instance of the REST module
const rest = new REST().setToken(config.DISCORD.BOT.TOKEN);

// and deploy your commands!
(async () => {
  try {
    logger.info(`Started refreshing application (/) commands.`);

    const globalCommands = commands.filter((c) => c.type === 4);
    const guildCommands = commands.filter((c) => c.type !== 4);

    // Deploy Guild Commands
    if (guildCommands.length > 0) {
      logger.info(`Deploying ${guildCommands.length} guild commands to ${deployOptions.label} (${deployOptions.guildId})...`);
      await rest.put(
        Routes.applicationGuildCommands(config.DISCORD.BOT.CLIENT_ID, deployOptions.guildId),
        { body: guildCommands },
      );
      logger.info(`Successfully reloaded guild commands for ${deployOptions.label}.`);
    }

    // Deploy Global Commands
    if (globalCommands.length > 0) {
      logger.info(`Deploying ${globalCommands.length} global commands...`);
      await rest.put(
        Routes.applicationCommands(config.DISCORD.BOT.CLIENT_ID),
        { body: globalCommands },
      );
      logger.info(`Successfully reloaded global commands.`);
    }
  } catch (error) {
    logger.error(error);
    process.exitCode = 1;
  }
})();

function getDeployOptions(args) {
  let guildId = String(config.DISCORD?.BOT?.GUILD_ID || '').trim();
  let label = 'configured guild';

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];

    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }

    if (arg === '--guild' || arg === '--guild-id') {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a guild id`);
      }
      guildId = String(value).trim();
      label = 'custom guild';
      index++;
      continue;
    }

    if (arg.startsWith('--guild=')) {
      guildId = arg.slice('--guild='.length).trim();
      label = 'custom guild';
      continue;
    }

    if (arg.startsWith('--guild-id=')) {
      guildId = arg.slice('--guild-id='.length).trim();
      label = 'custom guild';
      continue;
    }

    throw new Error(`Unknown deploy option: ${arg}`);
  }

  if (!/^\d+$/.test(guildId)) {
    throw new Error('Deploy guild id is missing or invalid');
  }

  return { guildId, label };
}

function printUsage() {
  console.log([
    'Usage: node src/deploy.js [options]',
    '',
    'Options:',
    '  --guild <guildId>   Deploy guild commands to a specific guild',
    '  --help              Show this help',
  ].join('\n'));
}
