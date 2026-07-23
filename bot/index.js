require('dotenv').config();
const { Client, GatewayIntentBits  } = require('discord.js');
const logger = require('../utils/logger');
const { handleInteraction, handleAutocomplete } = require('./interactionHandler');

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

client.once('clientReady', (readyClient) => {
  logger.info('Discord bot ready', { user: readyClient.user.tag });
});

client.on('interactionCreate', async (interaction) => {
  // Autocomplete must be responded to within ~3 seconds — handle it first
  if (interaction.isAutocomplete()) {
    await handleAutocomplete(interaction);
    return;
  }
  await handleInteraction(interaction);
});

const token = process.env.DISCORD_TOKEN;
if (!token) {
  logger.error('DISCORD_TOKEN is not set');
  process.exit(1);
}

client.login(token).catch((err) => {
  logger.error('Login failed:', err.message);
  process.exit(1);
});

client.on('error', (err) => {
  logger.error('Discord client error:', err.message);
});