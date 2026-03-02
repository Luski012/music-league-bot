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
       .setDescription("Submission duration (minutes)")
       .setRequired(true)
    )
    .addIntegerOption(o =>
      o.setName("voting_minutes")
       .setDescription("Voting duration (minutes)")
       .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Check current competition status")
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);

(async () => {
  await rest.put(
  Routes.applicationCommands(process.env.CLIENT_ID),
  { body: commands }
);

  console.log("Guild commands registered.");
})();

/* ---------------- PHASE LOGIC ---------------- */

async function startVoting(guildId) {
  const data = loadData();
  const g = data.guilds[guildId];
  if (!g) return;

  g.phase = "voting";
  g.submissions.sort(() => Math.random() - 0.5); // anonymous shuffle
  saveData(data);

  const channel = await client.channels.fetch(g.channelId);

  const embed = new EmbedBuilder()
    .setTitle("🗳️ Voting Phase Started!")
    .setDescription("Listen and vote for your favorite track.")
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

  const embed = new EmbedBuilder()
    .setTitle("🏆 Competition Results")
    .setColor(0xFFD700);

  results.forEach((r, i) => {
    embed.addFields({
      name: `${i + 1}. ${r.title}`,
      value: `${r.artist} — ${r.votes} votes\nSubmitted by <@${r.userId}>`
    });
  });

  // Champion role
  try {
    let role = channel.guild.roles.cache.find(r => r.name === "🏆 Music Champion");
    if (!role) {
      role = await channel.guild.roles.create({
        name: "🏆 Music Champion",
        color: 0xFFD700
      });
    }

    if (results[0]) {
      const winner = await channel.guild.members.fetch(results[0].userId);
      await winner.roles.add(role);
    }
  } catch {}

  await channel.send({ embeds: [embed] });

  data.guilds[guildId] = {};
  saveData(data);
}

/* ---------------- INTERACTIONS ---------------- */

client.on(Events.InteractionCreate, async interaction => {

  const data = loadData();
  const guildId = interaction.guild?.id;
  if (!guildId) return;

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
      const g = data.guilds[guildId];
      if (!g || g.phase !== "voting") {
        return interaction.reply({ content: "Voting not active.", ephemeral: true });
      }

      const index = parseInt(interaction.customId.split("_")[1]);
      g.votes[interaction.user.id] = index;
      saveData(data);

      return interaction.reply({ content: "Vote recorded!", ephemeral: true });
    }
  }

  /* ---------- MODAL ---------- */

  if (interaction.isModalSubmit()) {
    const link = interaction.fields.getTextInputValue("spotify_link");
    const g = data.guilds[guildId];

    if (!g || g.phase !== "submission") {
      return interaction.reply({ content: "Submissions closed.", ephemeral: true });
    }

    if (g.submissions.find(s => s.userId === interaction.user.id)) {
      return interaction.reply({ content: "You already submitted.", ephemeral: true });
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

  /* ---------- SLASH COMMANDS ---------- */

  if (!interaction.isChatInputCommand()) return;

  /* START (Admin Only) */
  if (interaction.commandName === "start") {

    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return interaction.reply({ content: "Only admins can start competitions.", ephemeral: true });
    }

    const theme = interaction.options.getString("theme");
    const submissionMinutes = interaction.options.getInteger("submission_minutes");
    const votingMinutes = interaction.options.getInteger("voting_minutes");

    data.guilds[guildId] = {
      active: true,
      phase: "submission",
      theme,
      submissions: [],
      votes: {},
      channelId: interaction.channelId
    };

    saveData(data);

    const embed = new EmbedBuilder()
      .setTitle("🎵 Music Competition Started")
      .setDescription(`Theme: **${theme}**\nClick below to submit.`)
      .setColor(0x1DB954);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("submit_track")
        .setLabel("Submit Song")
        .setStyle(ButtonStyle.Success)
    );

    await interaction.reply({ embeds: [embed], components: [row] });

    activeTimers[guildId] = setTimeout(async () => {
      await startVoting(guildId);

      activeTimers[guildId] = setTimeout(async () => {
        await endCompetition(guildId);
      }, votingMinutes * 60 * 1000);

    }, submissionMinutes * 60 * 1000);
  }

  /* STATUS */
  if (interaction.commandName === "status") {

    const g = data.guilds[guildId];

    if (!g || !g.active) {
      return interaction.reply("❌ No active competition.");
    }

    const embed = new EmbedBuilder()
      .setTitle("🎵 Competition Status")
      .setColor(0x1DB954)
      .addFields(
        { name: "Theme", value: g.theme },
        { name: "Phase", value: g.phase },
        { name: "Submissions", value: String(g.submissions.length) }
      );

    return interaction.reply({ embeds: [embed] });
  }

});

client.login(process.env.TOKEN);