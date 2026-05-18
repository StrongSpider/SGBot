'use strict';

const { SlashCommandBuilder } = require('discord.js');
const {
  getGroupId,
  getRobloxApi,
  replyError,
  resolveRobloxUser,
} = require('./roblox/shared');
const {
  evaluateAddRoleEligibility,
  evaluateRequirementAssetOwnership,
  renderAddRoleCheckResponse,
} = require('./roblox/roleEligibility');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('roblox-check')
    .setDescription('Check Roblox add-role requirements for a user')
    .addStringOption((option) => option
      .setName('user')
      .setDescription('Roblox username, Roblox ID, or Discord mention')
      .setRequired(true)),

  async execute(interaction) {
    try {
      await interaction.deferReply();

      const target = await resolveRobloxUser(interaction, interaction.options.getString('user', true));
      const api = getRobloxApi();
      const groupId = getGroupId();
      const [eligibility, shirts] = await Promise.all([
        evaluateAddRoleEligibility(api, target, null, groupId),
        evaluateRequirementAssetOwnership(api, target),
      ]);

      await interaction.editReply(renderAddRoleCheckResponse({
        target,
        result: eligibility,
        shirts,
      }));
      return true;
    } catch (err) {
      await replyError(interaction, err);
      return false;
    }
  },
};
