'use strict';

const { MessageFlags } = require('discord.js');

const LoggerClass = require('../../api/logger');
const logger = new LoggerClass('InteractionHandler', 'BOT');

module.exports = async function interactionCreateHandler(interaction) {
  if (!interaction) {
    return;
  }

  const isCommand = interaction.isChatInputCommand?.();
  const isAutocomplete = interaction.isAutocomplete?.();
  const isComponent = interaction.isMessageComponent?.();

  if (!isCommand && !isAutocomplete && !isComponent) {
    return;
  }

  const command = isComponent
    ? getComponentCommand(interaction)
    : interaction.client.commands.get(interaction.commandName);
  if (!command) {
    if (isAutocomplete) {
      await interaction.respond([]).catch(() => {});
      return;
    }

    await interaction.reply({
      content: 'Unknown command.',
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
    return;
  }

  try {
    if (isAutocomplete) {
      if (typeof command.autocomplete === 'function') {
        await command.autocomplete(interaction);
      } else {
        await interaction.respond([]);
      }
      return;
    }

    if (isComponent) {
      if (typeof command.handleComponent !== 'function') {
        throw new Error('This component is not wired to a handler');
      }
      await command.handleComponent(interaction);
      return;
    }

    await command.execute(interaction);
  } catch (err) {
    const message = err?.message || String(err);
    const label = isComponent ? interaction.customId : interaction.commandName;
    logger.error(`Command ${label} failed: ${message}`);

    if (isAutocomplete) {
      await interaction.respond([]).catch(() => {});
      return;
    }

    const payload = {
      content: `Error: \`${message}\``,
      flags: MessageFlags.Ephemeral,
    };

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: payload.content }).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
};

function getComponentCommand(interaction) {
  const customId = String(interaction.customId || '');
  if (customId.startsWith('roblox-policy:')) {
    return interaction.client.commands.get('roblox-policy');
  }
  return null;
}
