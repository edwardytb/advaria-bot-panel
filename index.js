const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const express = require('express');
const { QuickDB } = require('quick.db');
const path = require('path');
const config = require('./config');

const db = new QuickDB();
const app = express();
app.use(express.json());
app.use(express.static('views'));

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

// Cache temporal para detección de Anti-Spam
const userMessageCache = new Map();

// --- 1. REGISTRO DE COMANDOS SLASH ---
const commands = [
    new SlashCommandBuilder()
        .setName('activars')
        .setDescription('Activa el sistema de seguridad de Advaria en este servidor.')
        .addStringOption(option => 
            option.setName('clave')
                .setDescription('Clave de activación proporcionada por Advaria')
                .setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('clear')
        .setDescription('Elimina una cantidad específica de mensajes en el canal.')
        .addIntegerOption(option =>
            option.setName('cantidad')
                .setDescription('Número de mensajes a eliminar (1 a 100)')
                .setMinValue(1)
                .setMaxValue(100)
                .setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

    new SlashCommandBuilder()
        .setName('untimeout')
        .setDescription('Quita el aislamiento (mute) a un usuario sancionado.')
        .addUserOption(option =>
            option.setName('usuario')
                .setDescription('El usuario al que deseas quitar la sanción')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('razon')
                .setDescription('Motivo por el cual se retira la sanción')
                .setRequired(false))
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(config.token);

client.once('ready', async () => {
    console.log(`✅ Bot conectado como: ${client.user.tag}`);
    try {
        await rest.put(Routes.applicationCommands(config.clientId), { body: commands });
        console.log('✅ Comandos Slash (/activars, /clear, /untimeout) registrados correctamente.');
    } catch (error) {
        console.error('Error registrando comandos:', error);
    }
});

// --- FUNCIÓN DE VERIFICACIÓN DE PERMISOS / ROLES AUTORIZADOS ---
async function isAuthorizedStaff(interaction) {
    if (interaction.member.permissions.has(PermissionFlagsBits.Administrator) || 
        interaction.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
        return true;
    }

    const modRolesString = await db.get(`modRole_${interaction.guildId}`);
    if (modRolesString) {
        const modRoles = modRolesString.split(',').map(r => r.trim());
        const hasRole = interaction.member.roles.cache.some(role => modRoles.includes(role.id));
        if (hasRole) return true;
    }

    return false;
}

// --- FUNCIÓN AUXILIAR PARA ALERTAR A LOS ROLES Y ENVIAR LOGS AL CANAL DE REPORTES ---
async function notifyStaffAndLog(guild, logChannel, modRolesString, embed) {
    if (!logChannel) return;

    let roleMentions = "";
    if (modRolesString && modRolesString.trim().length > 0) {
        const rolesArray = modRolesString.split(',').map(r => r.trim());
        roleMentions = rolesArray.map(roleId => `<@&${roleId}>`).join(' ');
    }

    try {
        await logChannel.send({
            content: roleMentions ? `⚠️ **Alerta para el Staff:** ${roleMentions}` : null,
            embeds: [embed]
        });
    } catch (err) {
        console.error("Error enviando log:", err);
    }
}

// --- 2. MANEJO DE COMANDOS SLASH ---
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    // --- COMANDO /ACTIVARS ---
    if (interaction.commandName === 'activars') {
        const key = interaction.options.getString('clave');

        if (!config.validKeys.includes(key)) {
            return interaction.reply({ content: '❌ Clave de activación inválida.', ephemeral: true });
        }

        await db.set(`activated_${interaction.guildId}`, true);
        
        const embed = new EmbedBuilder()
            .setTitle('🛡️ Seguridad Advaria Activada')
            .setDescription(`Este servidor ha sido verificado correctamente con la clave \`${key}\`.\n\nPuedes configurar los parámetros desde el panel web: http://localhost:${config.port}/?guildId=${interaction.guildId}`)
            .setColor(0x00FF00);

        return interaction.reply({ embeds: [embed] });
    }

    // --- COMANDO /CLEAR ---
    if (interaction.commandName === 'clear') {
        const isActivated = await db.get(`activated_${interaction.guildId}`);
        if (!isActivated) {
            return interaction.reply({ content: '❌ Este servidor no ha activado el sistema de seguridad Advaria. Usa `/activars`.', ephemeral: true });
        }

        const amount = interaction.options.getInteger('cantidad');

        try {
            const deleted = await interaction.channel.bulkDelete(amount, true);
            await interaction.reply({ content: `🧹 Se han eliminado **${deleted.size}** mensajes correctamente.`, ephemeral: true });
        } catch (error) {
            console.error(error);
            await interaction.reply({ content: '❌ Ocurrió un error al intentar borrar los mensajes (mensajes de más de 14 días no se pueden borrar masivamente).', ephemeral: true });
        }
    }

    // --- COMANDO /UNTIMEOUT ---
    if (interaction.commandName === 'untimeout') {
        const isActivated = await db.get(`activated_${interaction.guildId}`);
        if (!isActivated) {
            return interaction.reply({ content: '❌ Este servidor no ha activado el sistema de seguridad Advaria. Usa `/activars`.', ephemeral: true });
        }

        const authorized = await isAuthorizedStaff(interaction);
        if (!authorized) {
            return interaction.reply({ content: '⛔ No tienes permisos ni los roles requeridos para desmutear usuarios.', ephemeral: true });
        }

        const targetUser = interaction.options.getUser('usuario');
        const reason = interaction.options.getString('razon') || 'Sanción retirada por el Staff';
        const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

        if (!member) {
            return interaction.reply({ content: '❌ El usuario especificado no se encuentra en el servidor.', ephemeral: true });
        }

        if (!member.isCommunicationDisabled()) {
            return interaction.reply({ content: `ℹ️ **${targetUser.tag}** no tiene ningún aislamiento activo.`, ephemeral: true });
        }

        try {
            await member.timeout(null, reason);

            await targetUser.send(`🔊 Tu aislamiento en **${interaction.guild.name}** ha sido retirado por ${interaction.user.tag}.\n**Motivo:** ${reason}`).catch(() => {});

            await interaction.reply({ content: `✅ Se le ha retirado el aislamiento a **${targetUser.tag}** con éxito.`, ephemeral: true });

            const logChannelId = await db.get(`logChannel_${interaction.guildId}`);
            const modRoles = await db.get(`modRole_${interaction.guildId}`);
            const logChannel = logChannelId ? interaction.guild.channels.cache.get(logChannelId) : null;

            const logEmbed = new EmbedBuilder()
                .setTitle('🔊 Sanción Retirada (Untimeout)')
                .setColor(0x00FF00)
                .addFields(
                    { name: 'Usuario Liberado', value: `${targetUser.tag} (${targetUser.id})`, inline: true },
                    { name: 'Moderador', value: `${interaction.user.tag}`, inline: true },
                    { name: 'Motivo', value: reason }
                )
                .setTimestamp();

            await notifyStaffAndLog(interaction.guild, logChannel, modRoles, logEmbed);

        } catch (error) {
            console.error(error);
            await interaction.reply({ content: '❌ No se le pudo quitar el aislamiento al usuario.', ephemeral: true });
        }
    }
});

// --- 3. SISTEMA DE AUTOMOD Y SEGURIDAD ---
client.on('messageCreate', async message => {
    if (message.author.bot || !message.guild) return;

    const guildId = message.guildId;
    const isActivated = await db.get(`activated_${guildId}`);
    if (!isActivated) return;

    if (message.channel.nsfw) return;

    const userId = message.author.id;
    const logChannelId = await db.get(`logChannel_${guildId}`);
    const modRoles = await db.get(`modRole_${guildId}`);
    const logChannel = logChannelId ? message.guild.channels.cache.get(logChannelId) : null;

    if (message.member.permissions.has(PermissionFlagsBits.Administrator) || 
        message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return;

    // --- A. FILTRO ANTI-NSFW (+18) ---
    const nsfwKeywords = [
        'porno', 'porn', 'hentai', 'xvideos', 'pornhub', 'xnxx', 
        'onlyfans', 'rule34', 'redtube', 'sex', 'nude', 'xxx'
    ];

    const contentLower = message.content.toLowerCase();
    const containsNSFWKeyword = nsfwKeywords.some(keyword => contentLower.includes(keyword));

    const hasNSFWAttachment = message.attachments.some(attachment => 
        nsfwKeywords.some(keyword => attachment.name.toLowerCase().includes(keyword))
    );

    if (containsNSFWKeyword || hasNSFWAttachment) {
        await message.delete().catch(() => {});

        message.author.send(`🔞 Tu mensaje/archivo en **${message.guild.name}** fue eliminado por contener contenido +18 / NSFW.`).catch(() => {});
        message.channel.send(`🚫 ${message.author}, el contenido +18 está estrictamente prohibido.`).then(m => setTimeout(() => m.delete(), 4000));

        try {
            await message.member.timeout(10 * 60 * 1000, "Violación de Seguridad: Envió de contenido +18 / NSFW");
        } catch (err) {}

        const logEmbed = new EmbedBuilder()
            .setTitle('🚨 Contenido +18 / NSFW Detectado')
            .setColor(0xFF0055)
            .addFields(
                { name: 'Usuario Sancionado', value: `${message.author.tag} (${message.author.id})`, inline: true },
                { name: 'Canal', value: `<#${message.channelId}>`, inline: true },
                { name: 'Sanción Aplicada', value: 'Aislamiento (10 Minutos)', inline: true },
                { name: 'Contenido', value: message.content || '[Archivo/Imagen Adjunta]' }
            )
            .setTimestamp();

        await notifyStaffAndLog(message.guild, logChannel, modRoles, logEmbed);
        return;
    }

    // --- B. DETECCIÓN DE ENLACES (ANTI-LINKS) ---
    const linkRegex = /(https?:\/\/[^\s]+)/g;
    if (linkRegex.test(message.content)) {
        await message.delete().catch(() => {});

        message.author.send(`⚠️ Tu mensaje en **${message.guild.name}** fue eliminado por contener enlaces no permitidos.`).catch(() => {});
        message.channel.send(`⚠️ ${message.author}, los enlaces no están permitidos por el sistema de seguridad.`).then(m => setTimeout(() => m.delete(), 4000));
        
        const logEmbed = new EmbedBuilder()
            .setTitle('🚨 Enlace Eliminado')
            .setColor(0xFFA500)
            .addFields(
                { name: 'Usuario', value: `${message.author.tag} (${message.author.id})`, inline: true },
                { name: 'Canal', value: `<#${message.channelId}>`, inline: true },
                { name: 'Contenido', value: message.content }
            )
            .setTimestamp();

        await notifyStaffAndLog(message.guild, logChannel, modRoles, logEmbed);
        return;
    }

    // --- C. DETECCIÓN DE SPAM (3 MENSAJES REPETIDOS) ---
    const userCache = userMessageCache.get(userId) || { lastMessage: "", count: 0 };
    
    if (userCache.lastMessage === message.content) {
        userCache.count += 1;
    } else {
        userCache.lastMessage = message.content;
        userCache.count = 1;
    }

    userMessageCache.set(userId, userCache);

    if (userCache.count >= 3) {
        const durationMs = 3 * 60 * 1000; // 3 minutos de Mute

        // 1. Eliminar el último mensaje de spam
        await message.delete().catch(() => {});

        // 2. Notificación en privado (MD) al usuario
        await message.author.send(`🤐 Has sido aislado por 3 minutos en **${message.guild.name}**. Motivo: Enviar mensajes repetidos (Anti-Spam).`).catch(() => {});

        try {
            // 3. Aplicar Aislamiento
            await message.member.timeout(durationMs, "Anti-Spam: 3 mensajes repetidos detectados");

            // 4. Mensaje temporal en chat público que se borra en 4 segundos
            message.channel.send(`🤐 ${message.author} ha sido aislado por 3 minutos por spam.`).then(m => setTimeout(() => m.delete(), 4000));
            
            // 5. Reporte completo enviándolo ÚNICAMENTE al canal de LOGS
            const logEmbed = new EmbedBuilder()
                .setTitle('🚨 Mute Automático - Anti-Spam')
                .setColor(0xFF0000)
                .addFields(
                    { name: 'Usuario Aislado', value: `${message.author.tag} (${message.author.id})`, inline: true },
                    { name: 'Duración', value: '3 Minutos', inline: true },
                    { name: 'Canal', value: `<#${message.channelId}>`, inline: true },
                    { name: 'Mensaje Repetido', value: message.content }
                )
                .setTimestamp();

            await notifyStaffAndLog(message.guild, logChannel, modRoles, logEmbed);
            userMessageCache.delete(userId);
        } catch (err) {
            console.error("No se pudo aplicar el timeout:", err);
        }
        return;
    }

    // --- D. DETECCIÓN ANTI-RAID (MENCIONES MASIVAS) ---
    if (message.mentions.users.size >= 5 || message.mentions.roles.size >= 3) {
        await message.delete().catch(() => {});

        await message.author.send(`🚨 Has sido aislado por 10 minutos en **${message.guild.name}**. Motivo: Menciones masivas / intento de raid.`).catch(() => {});

        try {
            await message.member.timeout(10 * 60 * 1000, "Anti-Raid: Menciones masivas detectadas");
            message.channel.send(`🚨 ${message.author} fue sancionado por menciones masivas.`).then(m => setTimeout(() => m.delete(), 4000));

            const logEmbed = new EmbedBuilder()
                .setTitle('🚨 Sanción Anti-Raid - Menciones Masivas')
                .setColor(0x8B0000)
                .addFields(
                    { name: 'Usuario Aislado', value: `${message.author.tag} (${message.author.id})`, inline: true },
                    { name: 'Duración', value: '10 Minutos', inline: true },
                    { name: 'Canal', value: `<#${message.channelId}>`, inline: true }
                )
                .setTimestamp();

            await notifyStaffAndLog(message.guild, logChannel, modRoles, logEmbed);
        } catch (err) {}
    }
});

// --- 4. PANEL WEB DE CONFIGURACIÓN ---
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

app.get('/api/config/:guildId', async (req, res) => {
    const guildId = req.params.guildId;
    const isActivated = await db.get(`activated_${guildId}`) || false;
    const logChannel = await db.get(`logChannel_${guildId}`) || "";
    const modRole = await db.get(`modRole_${guildId}`) || "";

    res.json({ isActivated, logChannel, modRole });
});

app.post('/api/config/:guildId', async (req, res) => {
    const guildId = req.params.guildId;
    const { logChannel, modRole } = req.body;

    await db.set(`logChannel_${guildId}`, logChannel);
    await db.set(`modRole_${guildId}`, modRole);

    res.json({ status: "success", message: "Configuración guardada correctamente." });
});

app.listen(config.port, () => {
    console.log(`🌐 Panel Web corriendo en http://localhost:${config.port}`);
});

client.login(config.token);