require('dotenv').config();
const { REST, Routes } = require('discord.js');
const logger = require('../utils/logger');

const commands = [
  {
    name: 'library-rooms',
    description: 'Find available library study and conference rooms at Rutgers',
    options: [
      {
        name: 'campus',
        type: 3,
        description: 'Filter by campus (optional)',
        required: false,
        choices: [
          { name: 'All Campuses',          value: 'all' },
          { name: 'Busch Campus',          value: 'busch' },
          { name: 'Camden Campus',         value: 'camden' },
          { name: 'College Avenue Campus', value: 'college_ave' },
          { name: 'Cook/Douglass Campus',  value: 'cook_douglass' },
          { name: 'Livingston Campus',     value: 'livingston' },
          { name: 'New Brunswick Campus',  value: 'new_brunswick' },
          { name: 'Newark Campus',         value: 'newark' },
        ]
      },
      {
        name: 'library',
        type: 3,
        description: 'Filter by specific library (optional)',
        required: false,
        choices: [
          { name: 'Alexander Library',                          value: 'alexander' },
          { name: 'Art Library',                               value: 'art' },
          { name: 'Carr Library',                              value: 'carr' },
          { name: 'Chang Library',                             value: 'chang' },
          { name: 'Dana Library',                              value: 'dana' },
          { name: 'Douglass Library',                          value: 'douglass' },
          { name: 'Library of Science & Medicine (LSM)',       value: 'lsm' },
          { name: 'Robert Wood Johnson Library - Health Sci',  value: 'rwj' },
          { name: 'Robeson Library',                           value: 'robeson' },
          { name: 'Smith Library - Health Sciences',           value: 'smith' },
        ]
      },
      {
        name: 'seats',
        type: 3,
        description: 'Minimum number of seats needed (optional)',
        required: false,
        choices: [
          { name: 'Any Number of Seats', value: 'any' },
          { name: '1–3 seats',           value: '1-3' },
          { name: '4–6 seats',           value: '4-6' },
          { name: '7+ seats',            value: '7+' },
        ]
      },
      {
        name: 'amenity',
        type: 3,
        description: 'Required amenity or technology (optional)',
        required: false,
        choices: [
          // Technology
          { name: 'Computer Station',      value: 'computer_station' },
          { name: 'HDMI Port & Monitor',   value: 'hdmi' },
          { name: 'Large Display',         value: 'large_display' },
          { name: 'Power & Wi-Fi',         value: 'power_wifi' },
          { name: 'Recording Equipment',   value: 'recording' },
          { name: 'USB Charging Hubs',     value: 'usb_charging' },
          { name: 'Webcam',                value: 'webcam' },
          // Amenities
          { name: 'Configurable Furniture', value: 'configurable_furniture' },
          { name: 'Group Table & Chairs',  value: 'group_table' },
          { name: 'Individual Desks',      value: 'individual_desks' },
          { name: 'Whiteboard & Markers',  value: 'whiteboard' },
        ]
      }
    ]
  },
  {
    name: 'student-center',
    description: 'Browse student center rooms (for established Rutgers organizations only)',
    options: [
      {
        name: 'date',
        type: 3,
        description: 'Date to check (e.g. "today", "tomorrow", "2026-08-01")',
        required: false
      }
    ]
  },
  {
    name: 'room-info',
    description: 'Get details on a specific library room — capacity, floor, amenities, and booking link',
    options: [
      {
        name: 'room',
        type: 3,
        description: 'Room name or number (e.g. "342", "Study Room 301A", "DLC Conference Room")',
        required: true,
        autocomplete: true
      }
    ]
  },
  {
    name: 'next-available',
    description: 'Get the LibCal link to find the next available slot for a library room',
    options: [
      {
        name: 'room',
        type: 3,
        description: 'Room name or number (e.g. "342", "Study Room 301A")',
        required: true,
        autocomplete: true
      },
      {
        name: 'date',
        type: 3,
        description: 'Date to check (e.g. "today", "tomorrow", "2026-08-01") — defaults to today',
        required: false
      }
    ]
  },
  {
    name: 'booking-links',
    description: 'Get official reservation links for library rooms or student center rooms',
    options: [
      {
        name: 'type',
        type: 3,
        description: 'What do you want to book?',
        required: true,
        choices: [
          { name: 'Library Room (all campuses)',   value: 'library' },
          { name: 'Alexander Library — Room 342', value: 'alex_342' },
          { name: 'Student Center Room',          value: 'student_center' },
        ]
      }
    ]
  },
  {
    name: 'ask',
    description: 'Ask anything about room booking at Rutgers',
    options: [
      {
        name: 'question',
        type: 3,
        description: 'Your question about rooms, availability, or reservations',
        required: true
      }
    ]
  },
  {
    name: 'help',
    description: 'Show all available commands',
    options: []
  }
];

async function registerCommands() {
  const token = process.env.DISCORD_TOKEN;
  const appId = process.env.DISCORD_APP_ID;

  if (!token) { logger.error('DISCORD_TOKEN is not set'); process.exit(1); }
  if (!appId)  { logger.error('DISCORD_APP_ID is not set'); process.exit(1); }

  console.log('Token exists:', !!token);
  console.log('Token length:', token?.length);
  console.log('App ID:', appId);

  const rest = new REST({ version: '10' }).setToken(token);

  try {
    logger.info('Registering slash commands...');
    const data = await rest.put(Routes.applicationCommands(appId), { body: commands });
    logger.info('Successfully registered', data.length, 'command(s)');
    process.exit(0);
  } catch (err) {
    logger.error('Failed to register commands:', err.message);
    process.exit(1);
  }
}

registerCommands();