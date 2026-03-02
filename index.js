// FULL TRACKBATTLE LEAGUE VERSION

require("dotenv").config();
const fs = require("fs");
const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionsBitField
} = require("discord.js");

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

const DATA_FILE = "./data.json";
const activeTimers = {};

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ guilds: {} }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DATA_FILE));
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

/* ---------------- SPOTIFY ---------------- */

async function getSpotifyToken() {
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Authorization":
        "Basic " +
        Buffer.from(
          process.env.SPOTIFY_CLIENT_ID +
            ":" +
            process.env.SPOTIFY_CLIENT_SECRET
        ).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });

  const data = await response.json();
  return data.access_token;
}

async function getTrackInfo(link) {
  try {
    const token = await getSpotifyToken();
    const trackId = link.split("/track/")[1]?.split("?")[0];
    if (!trackId) return null;

    const res = await fetch(
      `https://api.spotify.com/v1/tracks/${trackId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    return await res.json();
  } catch {
    return null;
  }
}

/* ---------------- COMMANDS ---------------- */

const commands = [
  new SlashCommandBuilder()
    .setName("start")
    .setDescription("Start a timed music competition")
    .addStringOption(o =>
      o.setName("theme").setDescription("Competition theme").setRequired(true)
    )
    .addIntegerOption(o =>
      o.setName("submission_minutes")
       .setDescription("Submission duration")
       .setRequired(true)
    )
    .addIntegerOption(o =>
      o.setName("voting_minutes")
       .setDescription("Voting duration")
       .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Check competition status"),

  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("View server leaderboard"),

  new SlashCommandBuilder()
    .setName("history")
    .setDescription("View past winners")
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);

(async () => {
  await rest.put(
    Routes.applicationCommands(process.env.CLIENT_ID),
    { body: commands }
  );
  console.log("Global commands registered.");
})();

/* ---------------- COMPETITION LOGIC ---------------- */

async function sendReminder(guildId, message) {
  const data = loadData();
  const g = data.guilds[guildId];
  if (!g) return;
  const channel = await client.channels.fetch(g.channelId);
  await channel.send(`⏰ ${message}`);
}

async function startVoting(guildId) {
  const data = loadData();
  const g = data.guilds[guildId];
  if (!g) return;

  g.phase = "voting";
  g.submissions.sort(() => Math.random() - 0.5);
  saveData(data);

  const channel = await client.channels.fetch(g.channelId);

  const embed = new EmbedBuilder()
    .setTitle("🗳️ Voting Phase Started!")
    .setColor(0x5865F2);

  const components = [];

  g.submissions.forEach((s, i) => {
    embed.addFields({
      name: `#${i + 1} — ${s.title}`,
      value: s.artist
    });

    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel("🎧 Listen")
          .setStyle(ButtonStyle.Link)
          .setURL(s.url),
        new ButtonBuilder()
          .setCustomId(`vote_${i + 1}`)
          .setLabel(`Vote #${i + 1}`)
          .setStyle(ButtonStyle.Primary)
      )
    );
  });

  await channel.send({ embeds: [embed], components });
}

async function endCompetition(guildId) {
  const data = loadData();
  const g = data.guilds[guildId];
  if (!g) return;

  const channel = await client.channels.fetch(g.channelId);

  const results = g.submissions.map((s, i) => {
    const count = Object.values(g.votes).filter(v => v === i + 1).length;
    return { ...s, votes: count };
  });

  results.sort((a, b) => b.votes - a.votes);

  const winner = results[0];

  if (winner) {
    if (!g.stats[winner.userId]) {
      g.stats[winner.userId] = { wins: 0, submissions: 0, streak: 0 };
    }
    g.stats[winner.userId].wins += 1;
    g.stats[winner.userId].streak += 1;
  }

  g.submissions.forEach(s => {
    if (!g.stats[s.userId]) {
      g.stats[s.userId] = { wins: 0, submissions: 0, streak: 0 };
    }
    g.stats[s.userId].submissions += 1;
  });

  g.history.push({
    theme: g.theme,
    winner: winner ? winner.userId : null,
    song: winner ? winner.title : null
  });

  saveData(data);

  const embed = new EmbedBuilder()
    .setTitle("🏆 Competition Results")
    .setColor(0xFFD700);

  results.forEach((r, i) => {
    embed.addFields({
      name: `${i + 1}. ${r.title}`,
      value: `${r.artist} — ${r.votes} votes\nSubmitted by <@${r.userId}>`
    });
  });

  await channel.send({ embeds: [embed] });

  g.active = false;
  saveData(data);
}

/* ---------------- INTERACTIONS ---------------- */

client.on(Events.InteractionCreate, async interaction => {

  const data = loadData();
  const guildId = interaction.guild?.id;
  if (!guildId) return;

  if (!data.guilds[guildId]) {
    data.guilds[guildId] = {
      active: false,
      stats: {},
      history: []
    };
    saveData(data);
  }

  const g = data.guilds[guildId];

  if (interaction.isButton()) {

    if (interaction.customId === "submit_track") {
      const modal = new ModalBuilder()
        .setCustomId("submit_modal")
        .setTitle("Submit Your Track");

      const input = new TextInputBuilder()
        .setCustomId("spotify_link")
        .setLabel("Spotify Track URL")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }

    if (interaction.customId.startsWith("vote_")) {
      if (g.phase !== "voting") {
        return interaction.reply({ content: "Voting not active.", ephemeral: true });
      }

      const index = parseInt(interaction.customId.split("_")[1]);
      g.votes[interaction.user.id] = index;
      saveData(data);

      return interaction.reply({ content: "Vote recorded!", ephemeral: true });
    }
  }

  if (interaction.isModalSubmit()) {
    const link = interaction.fields.getTextInputValue("spotify_link");

    if (g.phase !== "submission") {
      return interaction.reply({ content: "Submissions closed.", ephemeral: true });
    }

    const track = await getTrackInfo(link);
    if (!track) {
      return interaction.reply({ content: "Invalid Spotify link.", ephemeral: true });
    }

    g.submissions.push({
      userId: interaction.user.id,
      title: track.name,
      artist: track.artists.map(a => a.name).join(", "),
      url: track.external_urls.spotify
    });

    saveData(data);

    return interaction.reply({ content: "Submission received!", ephemeral: true });
  }

  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "leaderboard") {

    const sorted = Object.entries(g.stats)
      .sort((a, b) => b[1].wins - a[1].wins);

    if (sorted.length === 0) {
      return interaction.reply("No stats yet.");
    }

    const embed = new EmbedBuilder()
      .setTitle("🏆 Server Leaderboard")
      .setColor(0xFFD700);

    sorted.slice(0, 10).forEach(([userId, stats], i) => {
      embed.addFields({
        name: `${i + 1}. <@${userId}>`,
        value: `Wins: ${stats.wins} | Submissions: ${stats.submissions}`
      });
    });

    return interaction.reply({ embeds: [embed] });
  }

  if (interaction.commandName === "history") {

    if (g.history.length === 0) {
      return interaction.reply("No past competitions.");
    }

    const embed = new EmbedBuilder()
      .setTitle("📜 Competition History")
      .setColor(0x5865F2);

    g.history.slice(-10).reverse().forEach(h => {
      embed.addFields({
        name: h.theme,
        value: h.winner ? `Winner: <@${h.winner}> — ${h.song}` : "No winner"
      });
    });

    return interaction.reply({ embeds: [embed] });
  }

  if (interaction.commandName === "start") {

    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return interaction.reply({ content: "Admins only.", ephemeral: true });
    }

    const theme = interaction.options.getString("theme");
    const submissionMinutes = interaction.options.getInteger("submission_minutes");
    const votingMinutes = interaction.options.getInteger("voting_minutes");

    g.active = true;
    g.phase = "submission";
    g.theme = theme;
    g.submissions = [];
    g.votes = {};
    g.channelId = interaction.channelId;

    saveData(data);

    const embed = new EmbedBuilder()
      .setTitle("🎵 Competition Started")
      .setDescription(`Theme: **${theme}**`)
      .setColor(0x1DB954);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("submit_track")
        .setLabel("Submit Song")
        .setStyle(ButtonStyle.Success)
    );

    await interaction.reply({ embeds: [embed], components: [row] });

    setTimeout(() => sendReminder(guildId, "5 minutes left to submit!"),
      (submissionMinutes * 60 * 1000) - (5 * 60 * 1000));

    setTimeout(async () => {
      await startVoting(guildId);

      setTimeout(() => sendReminder(guildId, "5 minutes left to vote!"),
        (votingMinutes * 60 * 1000) - (5 * 60 * 1000));

      setTimeout(() => endCompetition(guildId),
        votingMinutes * 60 * 1000);

    }, submissionMinutes * 60 * 1000);
  }

  if (interaction.commandName === "status") {
    if (!g.active) {
      return interaction.reply("No active competition.");
    }

    return interaction.reply(
      `Theme: ${g.theme}\nPhase: ${g.phase}\nSubmissions: ${g.submissions.length}`
    );
  }

});

client.login(process.env.TOKEN);