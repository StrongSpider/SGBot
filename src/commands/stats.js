'use strict';

const {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} = require('discord.js');
const { getUserCommandUsage } = require('../commandUsage');

const MAX_COMMAND_LINES = 20;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Show successful command usage stats')
    .addUserOption((option) => option
      .setName('user')
      .setDescription('User to show stats for')
      .setRequired(false)),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const targetUser = interaction.options.getUser('user') || interaction.user;
    const usage = await getUserCommandUsage(targetUser.id);

    await interaction.editReply({
      embeds: [renderStatsEmbed(targetUser, usage)],
    });
    return true;
  },
};

function renderStatsEmbed(user, usage) {
  const embed = new EmbedBuilder()
    .setTitle(`Command Stats: ${user.tag || user.username || user.id}`)
    .setColor(0x3498db)
    .setTimestamp(new Date())
    .setFooter({
      text: `Successful slash commands only. Week starts ${formatShortDate(usage.weekStart)} UTC.`,
    });

  if (usage.commands.length === 0) {
    embed.setDescription('No successful command usage has been recorded for this user.');
    return embed;
  }

  embed.addFields({
    name: 'Totals',
    value: [
      `All time: ${usage.totals.allTime}`,
      `This month: ${usage.totals.monthly}`,
      `This week: ${usage.totals.weekly}`,
    ].join('\n'),
    inline: false,
  });

  embed.addFields({
    name: 'Commands',
    value: usage.commands
      .slice(0, MAX_COMMAND_LINES)
      .map(formatCommandStatsLine)
      .join('\n'),
    inline: false,
  });

  const hiddenCount = usage.commands.length - MAX_COMMAND_LINES;
  if (hiddenCount > 0) {
    embed.addFields({
      name: 'More',
      value: `${hiddenCount} more command${hiddenCount === 1 ? '' : 's'} not shown.`,
      inline: false,
    });
  }

  return embed;
}

function formatCommandStatsLine(entry) {
  return [
    `/${entry.commandName}`,
    `all: ${entry.allTime}`,
    `month: ${entry.monthly}`,
    `week: ${entry.weekly}`,
  ].join(' | ');
}

function formatShortDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'unknown';
  }
  return date.toISOString().slice(0, 10);
}
