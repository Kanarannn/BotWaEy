import { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, downloadContentFromMessage } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import moment from 'moment';
import pino from 'pino';
import { Sticker, StickerTypes } from 'wa-sticker-formatter'; 

import { readDB, writeDB } from './utils/database.js';
import { parseTasksInput, formatDisplayDate, formatReminderDate } from './utils/formatter.js';
import { initScheduler } from './utils/scheduler.js';

dotenv.config();

// ID LID Unik Akun WhatsApp Kamu (Sebagai Owner)
const NOMOR_OWNER = "115324787654708";

// Variabel Global untuk status Maintenance Mode (Default: matikan/false)
let isMaintenance = false;

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('session');

    const sock = makeWASocket({
        logger: pino({ level: 'silent' }), 
        auth: state,
        printQRInTerminal: false,
        browser: Browsers.windows('Chrome'),
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: undefined
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.clear();
            qrcode.generate(qr, { small: true });
            console.log('👉 Scan QR Code di atas menggunakan WhatsApp Anda.');
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log(`[Koneksi] Terputus (Status: ${statusCode}). Reconnecting: ${shouldReconnect}`);
            
            if (shouldReconnect) {
                console.log('[Koneksi] Menunggu 5 detik sebelum menyambungkan ulang...');
                setTimeout(() => { startBot(); }, 5000);
            }
        } else if (connection === 'open') {
            console.log('✅ Bot WhatsApp Berhasil Terhubung!');
            initScheduler(sock);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        
        const body = msg.message.conversation || 
                     msg.message.extendedTextMessage?.text || 
                     msg.message.imageMessage?.caption || 
                     msg.message.videoMessage?.caption || '';
        
        if (!body.trim().startsWith('/')) return;

        const firstLine = body.trim().split('\n')[0];
        const command = firstLine.split(' ')[0].toLowerCase();
        const argsText = body.trim().substring(command.length).trim();

        // Cek apakah pengirim adalah kamu (Owner) berdasarkan ID LID
        const isOwner = from.includes(NOMOR_OWNER);

        // =============================================================
        // PROTEKSI: MAINTENANCE MODE (/OFF)
        // =============================================================
        // Jika mode maintenance aktif, dan yang chat BUKAN owner, langsung blokir perintahnya
        if (isMaintenance && !isOwner) {
            return await sock.sendMessage(from, { 
                text: '⚠️ *Mode Percobaan Aktif*\n\nMohon maaf, bot saat ini sedang dalam mode perbaikan/uji coba oleh Developer. Seluruh perintah dinonaktifkan untuk sementara waktu.' 
            });
        }

        console.log(`[Log Perintah] Menjalankan ${command} dari JID: ${from} (Status Owner: ${isOwner})`);

        try {
            // =============================================================
            // FEATURE TOGGLE: MODE MAINTENANCE (HANYA OWNER 👑)
            // =============================================================
            if (command === '/off') {
                if (!isOwner) {
                    return await sock.sendMessage(from, { text: '❌ Perintah ini rahasia dan hanya bisa dijalankan oleh pemilik bot!' });
                }
                
                if (isMaintenance) {
                    return await sock.sendMessage(from, { text: '📢 Bot memang sudah dalam mode percobaan sebelumnya.' });
                }

                isMaintenance = true;
                console.log('[System] Maintenance Mode diaktifkan oleh Owner.');
                return await sock.sendMessage(from, { text: '📴 *Maintenance Mode: ON*\n\nBot berhasil masuk ke mode percobaan. Sekarang hanya kamu yang bisa mengeksekusi semua perintah bot!' });
            }

            else if (command === '/on') {
                if (!isOwner) {
                    return await sock.sendMessage(from, { text: '❌ Perintah ini rahasia dan hanya bisa dijalankan oleh pemilik bot!' });
                }

                if (!isMaintenance) {
                    return await sock.sendMessage(from, { text: '📢 Bot sudah dalam mode publik dan bisa diakses semua orang.' });
                }

                isMaintenance = false;
                console.log('[System] Maintenance Mode dimatikan oleh Owner.');
                return await sock.sendMessage(from, { text: '🔛 *Maintenance Mode: OFF*\n\nBot kembali ke mode publik! Semua user sekarang sudah bisa mengakses fitur bot kembali seperti semula.' });
            }

            // =============================================================
            // FEATURE 1: MENU / HELP
            // =============================================================
            else if (command === '/menu' || command === '/help') {
                let menuMessage = `📌 *DASHBOARD BOT TUGAS & UTILITY* 🖥️\n\nHalo! Berikut adalah daftar perintah yang bisa kamu gunakan:\n\n` +
                    `📝 *1. Tambah Tugas* (Multiline)\n` +
                    `Format:\n\`/tambah Nama Tugas - DD/MM/YYYY\`\n\n` +
                    `📚 *2. Lihat Tugas Aktif*\n` +
                    `Format: \`/lihat\`\n\n` +
                    `✨ *3. Edit Tugas*\n` +
                    `Format:\n\`/edit Tugas Lama - Tugas Baru - DD/MM/YYYY\`\n\n` +
                    `✅ *4. Tandai Selesai*\n` +
                    `Format: \`/selesai Nama Tugas\`\n\n` +
                    `🗑️ *5. Hapus Tugas*\n` +
                    `Format: \`/hapus Nama Tugas\`\n\n` +
                    `🎨 *6. Buat Sticker*\n` +
                    `Format: Kirim/reply gambar dengan caption \`/sticker\`\n\n` +
                    `⚠️ _Catatan: Format tanggal tugas wajib DD/MM/YYYY_`;
                
                // Info tambahan khusus di menu milik owner jika mode percobaan menyala
                if (isOwner && isMaintenance) {
                    menuMessage += `\n\n🛠️ *Status Developer:* Mode Percobaan sedang aktif (\`/on\` untuk mematikan).`;
                }

                await sock.sendMessage(from, { text: menuMessage });
            }

            // =============================================================
            // FEATURE 2: MAKE STICKER
            // =============================================================
            else if (command === '/sticker' || command === '/stiker') {
                const isImage = msg.message.imageMessage || msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;
                const isVideo = msg.message.videoMessage || msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.videoMessage;

                if (!isImage && !isVideo) {
                    return await sock.sendMessage(from, { text: '❌ Gagal. Pastikan kamu mengirim gambar/video dengan caption `/sticker` ATAU reply gambar/video yang sudah ada!' });
                }

                await sock.sendMessage(from, { text: '⏳ Sedang mengonversi media menjadi stiker, tunggu sebentar...' });

                const mediaMessage = msg.message.imageMessage || msg.message.videoMessage || 
                                     msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage || 
                                     msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.videoMessage;

                const type = msg.message.imageMessage || msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage ? 'image' : 'video';
                
                const stream = await downloadContentFromMessage(mediaMessage, type);
                let buffer = Buffer.from([]);
                for await (const chunk of stream) {
                    buffer = Buffer.concat([buffer, chunk]);
                }

                const sticker = new Sticker(buffer, {
                    pack: 'Pilkom C Bot',
                    author: 'Muhammad Yaritsunal Firdaus',
                    type: StickerTypes.FULL,
                    quality: 70
                });

                const stickerBuffer = await sticker.toBuffer();
                await sock.sendMessage(from, { sticker: stickerBuffer });
            }

            // =============================================================
            // FEATURE 3: TAMBAH TUGAS
            // =============================================================
            else if (command === '/tambah') {
                if (!argsText) {
                    return await sock.sendMessage(from, { text: '❌ Format salah. Contoh:\n/tambah Matematika - 18/06/2026' });
                }

                const parsedTasks = parseTasksInput(body);
                if (parsedTasks.length === 0) {
                    return await sock.sendMessage(from, { text: '❌ Tidak ada tugas valid. Format harus *Nama Tugas - DD/MM/YYYY*' });
                }

                const db = readDB();
                const responseList = [];

                parsedTasks.forEach((t, index) => {
                    const newTask = {
                        id: uuidv4(),
                        nama: t.nama,
                        deadline: t.deadline,
                        owner: from,
                        status: 'aktif',
                        reminded: false,
                        createdAt: moment().toISOString()
                    };
                    db.push(newTask);
                    responseList.push(`${index + 1}. *${t.nama}*\n   📅 Deadline: ${formatDisplayDate(t.deadline)}\n   ⏰ Pengingat: ${formatReminderDate(t.deadline)}`);
                });

                writeDB(db);
                const totalAktif = db.filter(t => t.owner === from && t.status === 'aktif').length;
                await sock.sendMessage(from, { text: `✅ Berhasil disimpan!\n\n📚 *Daftar Tugas Baru*\n\n${responseList.join('\n\n')}\n\n🗂 Total tugas aktif: ${totalAktif}` });
            }

            // =============================================================
            // FEATURE 4: LIHAT TUGAS AKTIF
            // =============================================================
            else if (command === '/lihat') {
                const db = readDB();
                const userTasks = db.filter(t => t.owner === from && t.status === 'aktif');

                if (userTasks.length === 0) {
                    return await sock.sendMessage(from, { text: '🎉 Tidak ada tugas aktif saat ini. Kerja bagus!' });
                }

                const responseList = userTasks.map((t, index) => `${index + 1}. *${t.nama}*\n   Deadline: ${formatDisplayDate(t.deadline)}`);
                await sock.sendMessage(from, { text: `📚 *Tugas Aktif Kamu*\n\n${responseList.join('\n\n')}` });
            }

            // =============================================================
            // FEATURE 5: EDIT TUGAS
            // =============================================================
            else if (command === '/edit') {
                if (!argsText || !argsText.includes('-')) {
                    return await sock.sendMessage(from, { text: '❌ Format salah.\n\nContoh: `/edit Tugas Lama - Tugas Baru - 25/06/2026`' });
                }

                const parts = argsText.split('-').map(p => p.trim());
                if (parts.length < 3) {
                    return await sock.sendMessage(from, { text: '❌ Format kurang lengkap. Pastikan ada nama lama, nama baru, dan tanggal baru.' });
                }

                const namaLama = parts[0];
                const namaBaru = parts[1];
                const tanggalBaruStr = parts[2];

                const tanggalValid = moment(tanggalBaruStr, 'DD/MM/YYYY', true);
                if (!tanggalValid.isValid()) {
                    return await sock.sendMessage(from, { text: '❌ Format tanggal baru salah. Harus menggunakan format DD/MM/YYYY (Contoh: 28/06/2026)' });
                }

                const deadlineBaru = tanggalValid.format('YYYY-MM-DD');
                const db = readDB();
                
                const taskIndex = db.findIndex(t => t.owner === from && t.status === 'aktif' && t.nama.toLowerCase() === namaLama.toLowerCase());

                if (taskIndex === -1) {
                    return await sock.sendMessage(from, { text: `❌ Tugas dengan nama "${namaLama}" tidak ditemukan atau sudah selesai.` });
                }

                db[taskIndex].nama = namaBaru;
                db[taskIndex].deadline = deadlineBaru;
                db[taskIndex].reminded = false;

                writeDB(db);
                await sock.sendMessage(from, { text: `✅ Tugas berhasil diperbarui!\n\n📝 Sebelum: *${namaLama}*\n✨ Menjadi: *${namaBaru}*\n📅 Deadline Baru: ${formatDisplayDate(deadlineBaru)}` });
            }

            // =============================================================
            // FEATURE 6: TANDAI TUGAS SELESAI
            // =============================================================
            else if (command === '/selesai') {
                const targetTask = argsText; 
                if (!targetTask) {
                    return await sock.sendMessage(from, { text: '❌ Harap masukkan nama tugas. Contoh: `/selesai Matematika`' });
                }

                const db = readDB();
                const taskIndex = db.findIndex(t => t.owner === from && t.status === 'aktif' && t.nama.toLowerCase() === targetTask.toLowerCase());

                if (taskIndex === -1) {
                    return await sock.sendMessage(from, { text: `❌ Tugas dengan nama "${targetTask}" tidak ditemukan atau sudah selesai.` });
                }

                db[taskIndex].status = 'selesai';
                writeDB(db);
                await sock.sendMessage(from, { text: `✅ Tugas "${db[taskIndex].nama}" ditandai selesai.` });
            }

            // =============================================================
            // FEATURE 7: HAPUS TUGAS
            // =============================================================
            else if (command === '/hapus') {
                const targetTask = argsText; 
                if (!targetTask) {
                    return await sock.sendMessage(from, { text: '❌ Harap masukkan nama tugas. Contoh: `/hapus Matematika`' });
                }

                let db = readDB();
                const initialLength = db.length;
                db = db.filter(t => !(t.owner === from && t.nama.toLowerCase() === targetTask.toLowerCase()));

                if (db.length === initialLength) {
                    return await sock.sendMessage(from, { text: `❌ Tugas dengan nama "${targetTask}" tidak ditemukan.` });
                }

                writeDB(db);
                await sock.sendMessage(from, { text: `🗑️ Tugas "${targetTask}" berhasil dihapus.` });
            }

            // =============================================================
            // FEATURE EXTRA: RESTART BOT
            // =============================================================
            else if (command === '/restart') {
                if (!isOwner) {
                    return await sock.sendMessage(from, { text: '❌ Perintah ini rahasia dan hanya bisa dijalankan oleh pemilik bot!' });
                }

                await sock.sendMessage(from, { text: '🔄 Sedang memicu restart server... Bot akan offline sekitar 5-10 detik untuk memproses pembaruan file.' });
                console.log('[System] Perintah restart dikonfirmasi owner LID. Mematikan proses Node.js...');
                
                setTimeout(() => { process.exit(0); }, 1000);
            }

        } catch (error) {
            console.error('Error:', error);
            await sock.sendMessage(from, { text: '🚨 Terjadi kesalahan internal sistem saat memproses perintah.' });
        }
    });
}

startBot();