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

/* ---------------- DATA ---------------- */

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
      Authorization:
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
    .setDescription("Start a music competition")
    .addStringOption(o =>
      o.setName("theme").setDescription("Competition theme").setRequired(true)
    )
    .addIntegerOption(o =>
      o.setName("submission_minutes").setDescription("Submission duration").setRequired(true)
    )
    .addIntegerOption(o =>
      o.setName("voting_minutes").setDescription("Voting duration").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Check competition status"),

  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("View server leaderboard"),

  new SlashCommandBuilder()
    .setName("history")
    .setDescription("View past competitions")
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);

(async () => {
  await rest.put(
    Routes.applicationCommands(process.env.CLIENT_ID),
    { body: commands }
  );
  console.log("Global commands registered.");
})();

/* ---------------- CORE LOGIC ---------------- */

async function sendReminder(guildId, message) {
  const data = loadData();
  const g = data.guilds[guildId];
  if (!g || !g.active) return;
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
    .setDescription("Listen and vote for your favorite track.")
    .setColor(0x5865F2)
    .setFooter({ text: "TrackBattle" });

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
    const votes = Object.values(g.votes).filter(v => v === i + 1).length;
    return { ...s, votes };
  });

  results.sort((a, b) => b.votes - a.votes);
  const winner = results[0];

  // Update stats
  results.forEach(r => {
    if (!g.stats[r.userId]) {
      g.stats[r.userId] = { wins: 0, submissions: 0 };
    }
    g.stats[r.userId].submissions += 1;
  });

  if (winner) {
    g.stats[winner.userId].wins += 1;
    g.history.push({
      theme: g.theme,
      winner: winner.userId,
      song: winner.title
    });
  }

  saveData(data);

  const embed = new EmbedBuilder()
    .setTitle("🏆 Competition Results")
    .setColor(0xFFD700)
    .setFooter({ text: "TrackBattle League" });

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

  /* ---------- BUTTONS ---------- */

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
      const submission = g.submissions[index - 1];

      // Anti-self vote
      if (submission.userId === interaction.user.id) {
        return interaction.reply({
          content: "You cannot vote for your own submission.",
          ephemeral: true
        });
      }

      g.votes[interaction.user.id] = index;
      saveData(data);

      return interaction.reply({ content: "Vote recorded!", ephemeral: true });
    }
  }

  /* ---------- MODAL ---------- */

  if (interaction.isModalSubmit()) {

    if (g.phase !== "submission") {
      return interaction.reply({ content: "Submissions closed.", ephemeral: true });
    }

    const link = interaction.fields.getTextInputValue("spotify_link");
    const track = await getTrackInfo(link);

    if (!track) {
      return interaction.reply({ content: "Invalid Spotify link.", ephemeral: true });
    }

    if (!g.submissions) g.submissions = [];
    if (!g.votes) g.votes = {};

    if (g.submissions.find(s => s.userId === interaction.user.id)) {
      return interaction.reply({ content: "You already submitted.", ephemeral: true });
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

  /* ---------- SLASH COMMANDS ---------- */

  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "start") {

    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return interaction.reply({ content: "Admins only.", ephemeral: true });
    }

    if (g.active) {
      return interaction.reply({ content: "A competition is already running.", ephemeral: true });
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
      .setTitle("🎵 TrackBattle Competition Started")
      .setDescription(`Theme: **${theme}**`)
      .setColor(0x1DB954)
      .setFooter({ text: "TrackBattle League" });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("submit_track")
        .setLabel("Submit Song")
        .setStyle(ButtonStyle.Success)
    );

    await interaction.reply({ embeds: [embed], components: [row] });

    if (submissionMinutes > 5) {
      setTimeout(() =>
        sendReminder(guildId, "5 minutes left to submit!"),
        (submissionMinutes - 5) * 60 * 1000
      );
    }

    setTimeout(async () => {

      await startVoting(guildId);

      if (votingMinutes > 5) {
        setTimeout(() =>
          sendReminder(guildId, "5 minutes left to vote!"),
          (votingMinutes - 5) * 60 * 1000
        );
      }

      setTimeout(() =>
        endCompetition(guildId),
        votingMinutes * 60 * 1000
      );

    }, submissionMinutes * 60 * 1000);
  }

  if (interaction.commandName === "status") {
    if (!g.active) {
      return interaction.reply("No active competition.");
    }

    return interaction.reply({
  content: `Theme: ${g.theme}\nPhase: ${g.phase}\nSubmissions: ${g.submissions.length}`,
  ephemeral: true
});

  }

  if (interaction.commandName === "leaderboard") {

  const sorted = Object.entries(g.stats)
    .sort((a, b) => b[1].wins - a[1].wins);

  if (sorted.length === 0) {
    return interaction.reply("No stats yet.");
  }

  const embed = new EmbedBuilder()
    .setTitle("🏆 Server Leaderboard")
    .setColor(0xFFD700)
    .setFooter({ text: "TrackBattle League" });

  for (let i = 0; i < Math.min(sorted.length, 10); i++) {
    const [userId, stats] = sorted[i];

    let username = "Unknown User";
    try {
      const member = await interaction.guild.members.fetch(userId);
      username = member.user.username;
    } catch {}

    embed.addFields({
      name: `${i + 1}. ${username}`,
      value: `Wins: ${stats.wins} | Submissions: ${stats.submissions}`
    });
  }

  return interaction.reply({ embeds: [embed], ephemeral: true });
}

  if (interaction.commandName === "history") {

    if (!g.history || g.history.length === 0) {
      return interaction.reply("No past competitions.");
    }

    const embed = new EmbedBuilder()
      .setTitle("📜 Competition History")
      .setColor(0x5865F2)
      .setFooter({ text: "TrackBattle League" });

    g.history.slice(-10).reverse().forEach(h => {
      embed.addFields({
        name: h.theme,
        value: `Winner: <@${h.winner}> — ${h.song}`
      });
    });

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

});

client.login(process.env.TOKEN);