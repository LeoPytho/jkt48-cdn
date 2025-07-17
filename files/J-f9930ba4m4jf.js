const { Client, GatewayIntentBits, REST, Routes, ActivityType } = require('discord.js');
const fs = require('fs');
const path = require('path');
const axios = require('axios'); // Import axios untuk mengirim request HTTP
require('./system/settings.js');
// Function to update activity presence with member count
const { getLive } = require('jkt48connect-cli');
const sendLiveNotification = require('./Discord/helpers/sendLiveNotification');
const sendEndedLiveNotification  = require('./Discord/helpers/endedNotif');
const { sendTheaterNotification, scheduleDailyTheaterNotification } = require('./Discord/helpers/schedule_theater');
const { scheduleShowReminders } = require('./Discord/helpers/SetlistNotif');
const startNewsPolling  = require('./Discord/helpers/newsHelperRl');

// Fetch global settings
const token = global.token;
const clientId = global.clientId;

// Initialize the Discord client
const discordClient = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// Tambahkan di bagian awal file untuk memuat semua event handler
const eventsPath = path.join(__dirname, 'Discord/events');
const eventFiles = fs.readdirSync(eventsPath).filter(file => file.endsWith('.js'));

for (const file of eventFiles) {
    const event = require(path.join(eventsPath, file));
    if (event.once) {
        discordClient.once(event.name, (...args) => event.execute(...args));
    } else {
        discordClient.on(event.name, (...args) => event.execute(...args));
    }
}

// Load all commands from the 'Discord/commands' folder
const commands = [];
discordClient.commands = new Map();

const commandFiles = fs.readdirSync(path.join(__dirname, 'Discord/commands')).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
    const command = require(`./Discord/commands/${file}`);
    commands.push({
        name: command.name,
        description: command.description,
        options: command.options || []
    });
    discordClient.commands.set(command.name, command);
}

// Handle slash command interactions
discordClient.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;

    const command = discordClient.commands.get(interaction.commandName);

    if (command) {
        try {
            await command.execute(interaction);
        } catch (error) {
            console.error(error);
            await interaction.reply({ content: 'There was an error executing this command!', ephemeral: true });
        }
    }
});

// Register slash commands
const rest = new REST({ version: '10' }).setToken(token);

(async () => {
    try {
        console.log('Started refreshing application (/) commands.');

        // Register slash commands
        await rest.put(
            Routes.applicationCommands(clientId),
            { body: commands }
        );

        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error('Error registering commands:', error);
    }
})();

// Send bot status to Vercel
const sendStatusToServer = async (status) => {
    try {
        await axios.post('https://botdiscordstatus.vercel.app/api/bot-status', {
            status: status
        });
        console.log(`Status sent to Vercel: ${status}`);
    } catch (error) {
        console.error('Error sending status to Vercel:', error);
    }
};

// List of names to rotate in the activity name
const activityNames = [
    'JKT48Connect',
    'Official JKT48 Platform',
    'Join JKT48Connect Family',
    'Watch Live Streams Now!',
    'Exciting Shows with JKT48'
];

// Counter to track the current name
let currentNameIndex = 0;



// Function to update activity presence dynamically
const updatePresence = async () => {
    try {
        // Fetching the member count from the first guild (server) the bot is in
        const memberCount = discordClient.guilds.cache.reduce((total, guild) => total + guild.memberCount, 0);

        // Fetch live stream data
        const liveData = await getLive(global.jkt48connect);

        // Extract live stream details
        const liveList = Object.values(liveData).filter(item => typeof item === 'object' && item.name); // Filter valid live items
        const liveStream = liveList.length > 0 ? liveList[Math.floor(Math.random() * liveList.length)] : null; // Random live

        // Prepare live message or fallback
        const liveMessage = liveStream 
            ? `Watching live ${liveStream.name}` 
            : activityNames[currentNameIndex]; // Default activity name

        // Calculate bot runtime
        const uptime = process.uptime(); // Runtime in seconds
        const runtime = new Date(uptime * 1000).toISOString().substr(11, 8); // Format as HH:mm:ss

        // Create dynamic activity name
        const dynamicName = `${liveMessage} | ${memberCount} members | Runtime: ${runtime}`;

        // Set the bot's presence with rotating activity name and member count
        await discordClient.user.setPresence({
            status: 'online',
            activities: [{
                type: ActivityType.Streaming,
                name: dynamicName,
                url: 'https://youtube.com/@valzyofc',// Dynamic name with runtime and live info
            }]
        });

        // Move to the next name in the array, looping back to the start
        currentNameIndex = (currentNameIndex + 1) % activityNames.length;
    } catch (error) {
        console.error('Error updating presence:', error);
    }
};



// When the bot is ready
discordClient.once('ready', async () => {
    console.log(`Logged in as ${discordClient.user.tag}`);

    // Send initial status to Vercel
    await sendStatusToServer('online');
    
    // Start updating presence every 10 seconds
    setInterval(updatePresence, 10000); // 10 seconds interval
});

// Periodically check for live streams
setInterval(async () => {
    await sendLiveNotification(discordClient); // Keep original function
}, 30000); // Check every ten seconds


setInterval(async () => {
    await sendEndedLiveNotification(discordClient); // New function for showroom
}, 30000); // Check every ten seconds

// Periodically check for theater schedules
setInterval(async () => {
    await sendTheaterNotification(discordClient);
}, 30000); // Check every hour

// Schedule daily 9 AM WIB theater notification
scheduleDailyTheaterNotification(discordClient);
// Setlist reminders
scheduleShowReminders(discordClient);
//Notif End
sendEndedLiveNotification(discordClient);
//Notif News
startNewsPolling(discordClient, 30000); // Interval polling 30 detik

// Log in to Discord
discordClient.login(token);
