import { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, downloadContentFromMessage } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import moment from 'moment';
import pino from 'pino';

import { readDB, writeDB, getUserEmail, setUserEmail } from './utils/database.js';
import { canAccessCalendar, addTaskToCalendar, updateEventDeadline, deleteCalendarEvent, getServiceAccountEmail } from './utils/calendar.js';
import { parseTaskLines, parseDeadlineReply, formatDeadline, formatDisplayDate, formatReminderDate } from './utils/formatter.js';
import { initScheduler } from './utils/scheduler.js';

dotenv.config();

const NOMOR_OWNER = "115324787654708";

let isMaintenance = false;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Pesan untuk cabang "N" di flowchart (email tidak bisa akses kalender)
const pesanHarusKonek = (email) => {
    const botEmail = getServiceAccountEmail() || '(email service account belum dikonfigurasi)';
    return `⚠️ *Harus konek dulu ke Google Calendar!*\n\n` +
        (email
            ? `Email *${email}* belum bisa mengakses kalender.\n\n`
            : `Kamu belum menghubungkan email Google.\n\n`) +
        `Cara konek:\n` +
        `1. Buka Google Calendar → ⚙️ Settings → pilih kalendermu → *Share with specific people*\n` +
        `2. Tambahkan \`${botEmail}\` dengan izin *Make changes to events*\n` +
        `3. Kirim \`/konek emailkamu@gmail.com\`\n\n` +
        `Setelah itu kirim ulang perintah \`/tambah\` kamu.`;
};

// Tugas yang sudah tercatat di kalender tapi deadline-nya belum diisi
const getPendingTasks = (db, jid) =>
    db.filter(t => t.owner === jid && t.status === 'aktif' && !t.deadline);

// Node "tanyain juga tanggal sama jam deadlinenya kapan"
const tanyaDeadline = async (sock, jid, task, sisaAntrean = 0) => {
    const antrean = sisaAntrean > 0 ? `\n\n_(${sisaAntrean} tugas lain menunggu setelah ini)_` : '';
    await sock.sendMessage(jid, {
        text: `📅 Deadline *${task.nama}* kapan?\n\n` +
            `Balas dengan tanggal dan jam, contoh:\n\`18/06/2026 23:59\`\n\n` +
            `_Jam boleh dikosongkan (event jadi seharian penuh). Ketik \`/batal\` untuk membatalkan._${antrean}`
    });
};

// Pengingat otomatis sekali kirim setelah deadline tugas terisi
const kirimPengingatAwal = (sock, jid, task) => {
    setTimeout(async () => {
        const sisaHari = moment(task.deadline, 'YYYY-MM-DD').diff(moment().startOf('day'), 'days');

        const reminderTemplate = `⏰ *PENGINGAT TUGAS AKADEMIK (AUTOMATIC)* ⏰\n\n` +
            `Halo! Sistem mendeteksi tugas kuliah baru terdaftar. Berikut adalah jadwal pengingat otomatisnya:\n\n` +
            `📝 *Tugas:* ${task.nama}\n` +
            `📅 *Deadline:* ${formatDeadline(task)}\n` +
            `⏳ *Sisa Waktu:* ${sisaHari <= 0 ? '*HARI INI BATASNYA!*' : `*${sisaHari} hari lagi*`}\n\n` +
            `💡 _Sistem otomatis akan mengingatkanmu kembali secara berkala. Ketik \`/selesai ${task.nama}\` jika sudah rampung agar tugas diarsipkan!_`;

        await sock.sendMessage(jid, { text: reminderTemplate });
    }, 1500);
};

// Menangani balasan user (non-command) berisi tanggal & jam deadline
const handleDeadlineReply = async (sock, from, body) => {
    const db = readDB();
    const pending = getPendingTasks(db, from);
    if (pending.length === 0) return;

    const task = pending[0];
    const parsed = parseDeadlineReply(body);
    const isGroup = from.endsWith('@g.us');

    if (!parsed) {
        // Di grup, chat biasa diabaikan supaya bot tidak nyepam
        if (!isGroup) {
            await sock.sendMessage(from, { text: `❌ Format tidak dikenali.\n\nDeadline *${task.nama}*: balas dengan \`DD/MM/YYYY HH:mm\`, contoh \`18/06/2026 23:59\`.\nKetik \`/batal\` untuk membatalkan.` });
        }
        return;
    }

    if (moment(parsed.deadline, 'YYYY-MM-DD').isBefore(moment().startOf('day'))) {
        return await sock.sendMessage(from, { text: '❌ Tanggal itu sudah lewat. Kirim tanggal deadline yang benar.' });
    }

    try {
        await updateEventDeadline(getUserEmail(from), task.calendarEventId, task.nama, parsed.deadline, parsed.time);
    } catch (error) {
        console.error(`[Calendar] Gagal update deadline "${task.nama}":`, error.message);
        return await sock.sendMessage(from, { text: '🚨 Gagal memperbarui Google Calendar. Coba kirim ulang tanggalnya.' });
    }

    task.deadline = parsed.deadline;
    task.deadlineTime = parsed.time;
    task.reminded = false;
    writeDB(db);

    await sock.sendMessage(from, {
        text: `✅ Deadline *${task.nama}* tersimpan & kalender diperbarui.\n📅 ${formatDeadline(task)}` +
            (parsed.time ? '' : '\n_(tanpa jam, jadi event seharian penuh)_')
    });
    kirimPengingatAwal(sock, from, task);

    const sisa = pending.slice(1);
    if (sisa.length > 0) {
        await tanyaDeadline(sock, from, sisa[0], sisa.length - 1);
    }
};

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('session');

    const sock = makeWASocket({
        logger: pino({ level: 'silent' }), 
        auth: state,
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'), 
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: undefined,
        syncFullHistory: false
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
        
        if (!body.trim()) return;

        // Balasan non-command: jawaban untuk pertanyaan deadline
        if (!body.trim().startsWith('/')) {
            if (isMaintenance && !from.includes(NOMOR_OWNER)) return;
            try {
                await handleDeadlineReply(sock, from, body);
            } catch (error) {
                console.error('Error deadline reply:', error);
            }
            return;
        }

        const firstLine = body.trim().split('\n')[0];
        const command = firstLine.split(' ')[0].toLowerCase();
        const argsText = body.trim().substring(command.length).trim();

        const isOwner = from.includes(NOMOR_OWNER);

        if (isMaintenance && !isOwner) {
            return await sock.sendMessage(from, { 
                text: '⚠️ *Mode Percobaan Aktif*\n\nMohon maaf, bot saat ini sedang dalam mode perbaikan/uji coba oleh Developer. Seluruh perintah dinonaktifkan untuk sementara waktu.' 
            });
        }

        console.log(`[Log Perintah] Menjalankan ${command} dari JID: ${from} (Status Owner: ${isOwner})`);

        try {
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

            else if (command === '/status') {
                if (!isOwner) {
                    return await sock.sendMessage(from, { text: '❌ Perintah ini rahasia dan hanya bisa dijalankan oleh pemilik bot!' });
                }

                await sock.sendMessage(from, { text: '📊 Sedang mengambil data metrik dari server WispByte, mohon tunggu...' });

                const memoryUsage = process.memoryUsage();
                const ramDipakai = (memoryUsage.rss / 1024 / 1024).toFixed(2);
                const heapTotal = (memoryUsage.heapTotal / 1024 / 1024).toFixed(2);
                const heapUsed = (memoryUsage.heapUsed / 1024 / 1024).toFixed(2);

                const os = await import('os');
                const uptimeServer = os.uptime();
                const uptimeBot = process.uptime();

                const formatUptime = (seconds) => {
                    const d = Math.floor(seconds / (3600*24));
                    const h = Math.floor(seconds % (3600*24) / 3600);
                    const m = Math.floor(seconds % 3600 / 60);
                    const s = Math.floor(seconds % 60);
                    return `${d > 0 ? d + 'hari ' : ''}${h}jam ${m}menit ${s}detik`;
                };

                const cpus = os.cpus();
                const modelCPU = cpus.length > 0 ? cpus[0].model : 'Unknown CPU';
                const totalCore = cpus.length;
                const loadAvg = os.loadavg();

                const statusMessage = `📊 *LAPORAN METRIK SERVER WISPBYTE* 🖥️\n\n` +
                    `👑 *Status Sesi:* Terhubung sebagai Owner\n` +
                    `🛠️ *Mode Bot:* ${isMaintenance ? '🛠️ Mode Percobaan (OFF)' : '🔛 Publik (ON)'}\n\n` +
                    `🧠 *PENGGUNAAN MEMORI (RAM):*\n` +
                    `▪️ Alokasi RAM Bot: *${ramDipakai} MB*\n` +
                    `▪️ Heap Virtual Terpakai: *${heapUsed} MB* / ${heapTotal} MB\n\n` +
                    `⚡ *PERFORMA CPU & SISTEM:*\n` +
                    `▪️ Model Prosesor: \`${modelCPU}\`\n` +
                    `▪️ Total Alokasi Core: *${totalCore} vCPU Core*\n` +
                    `▪️ Beban Kerja (Load Avg): *${loadAvg[0].toFixed(2)}* (1 mnt terakhir)\n\n` +
                    `⏱️ *WAKTU AKTIF (UPTIME):*\n` +
                    `▪️ Uptime Bot: _${formatUptime(uptimeBot)}_\n` +
                    `▪️ Uptime Node Server: _${formatUptime(uptimeServer)}_\n\n` +
                    `📅 *Waktu Pengecekan:* ${moment().format('DD MMMM YYYY - HH:mm:ss')} WIB`;

                return await sock.sendMessage(from, { text: statusMessage });
            }

            else if (command === '/info') {
                const infoMessage = `✨ *PROFIL DEVELOPER BOT* ✨\n\n` +
                    `👤 *Nama:* Muhammad Firdaus / Kanarann\n` +
                    `🌐 *Media Sosial & Kontak:*\n` +
                    `📸 Instagram: @knfrdss\n` +
                    `💬 _"Coding dengan logika, memimpin dengan rasa. Bot ini didevelop untuk mempermudah manajemen tugas perkuliahan kita agar tetap terstruktur dan anti-prokrastinasi!"_`;
                
                return await sock.sendMessage(from, { text: infoMessage });
            }

            else if (command === '/donate' || command === '/donasi') {
                const donateMessage = `☕ *SUPPORT & DONASI BOT TUGAS* ☕\n\nHalo! Jika bot ini dirasa bermanfaat membantu keseharian kuliahmu, kamu bisa mendukung biaya sewa server panel WispByte dan operasional pengembangannya lewat platform di bawah ini:\n\n` +
                    `💳 *E-Wallet & Bank:*\n` +
                    `▪️ *Dana:* 0851-XXXX-XXXX (a.n. Muhammad Yaritsunal)\n` +
                    `▪️ *Gopay / OVO:* 0851-XXXX-XXXX\n` +
                    `▪️ *Bank BCA:* 139-XXXX-XXX\n\n` +
                    `🌐 *Digital Support:*\n` +
                    `▪️ *Saweria:* saweria.co/knfrdss\n` +
                    `▪️ *Trakteer:* trakteer.id/knfrdss\n\n` +
                    `Berapapun donasi yang kamu berikan akan sangat membantu bot ini tetap online 24 jam penuh tanpa iklan. Terima kasih banyak atas dukungannya! 🙏✨`;
                
                return await sock.sendMessage(from, { text: donateMessage });
            }

            else if (command === '/menu' || command === '/help') {
                let menuMessage = `📌 *DASHBOARD BOT TUGAS & UTILITY* 🖥️\n\nHalo! Berikut adalah daftar perintah yang bisa kamu gunakan:\n\n` +
                    `📝 *1. Tambah Tugas* (Multiline, otomatis masuk Google Calendar)\n` +
                    `Format:\n\`/tambah Nama Tugas\` (bot akan tanya tanggal & jam deadline)\natau \`/tambah Nama Tugas - DD/MM/YYYY HH:mm\`\n` +
                    `Batal isi deadline: \`/batal\`\n\n` +
                    `🔗 *Konek Google Calendar* (wajib sebelum /tambah)\n` +
                    `Format: \`/konek emailkamu@gmail.com\`\n\n` +
                    `📚 *2. Lihat Tugas Aktif*\n` +
                    `Format: \`/lihat\`\n\n` +
                    `✨ *3. Edit Tugas*\n` +
                    `Format:\n\`/edit Tugas Lama - Tugas Baru - DD/MM/YYYY\`\n\n` +
                    `✅ *4. Tandai Selesai*\n` +
                    `Format: \`/selesai Nama Tugas\`\n\n` +
                    `🗑️ *5. Hapus Tugas*\n` +
                    `Format: \`/hapus Nama Tugas\`\n\n` +
                    `🎨 *6. Ubah Gambar ke Sticker*\n` +
                    `Format: Reply gambar dengan \`/sticker\`\n\n` +
                    `ℹ️ *7. Info Developer*\n` +
                    `Format: \`/info\`\n\n` +
                    `☕ *8. Donasi Server*\n` +
                    `Format: \`/donate\`\n\n` +
                    `⚠️ _Catatan: Format tanggal tugas wajib DD/MM/YYYY_`;

                if (isOwner && isMaintenance) {
                    menuMessage += `\n\n🛠️ *Status Developer:* Mode Percobaan sedang aktif (\`/on\` untuk mematikan).`;
                }

                await sock.sendMessage(from, { text: menuMessage });
            }

            else if (command === '/konek') {
                const email = (argsText || getUserEmail(from) || '').trim().toLowerCase();

                if (!email) {
                    return await sock.sendMessage(from, { text: '❌ Sertakan email Google kamu. Contoh:\n`/konek nama@gmail.com`' });
                }
                if (!EMAIL_REGEX.test(email)) {
                    return await sock.sendMessage(from, { text: '❌ Format email tidak valid. Contoh: `/konek nama@gmail.com`' });
                }

                setUserEmail(from, email);

                if (await canAccessCalendar(email)) {
                    return await sock.sendMessage(from, { text: `✅ Terhubung! Kalender *${email}* bisa diakses.\n\nSekarang tugas dari \`/tambah\` otomatis masuk ke Google Calendar-mu.` });
                }
                return await sock.sendMessage(from, { text: pesanHarusKonek(email) });
            }

            else if (command === '/tambah') {
                if (!argsText) {
                    return await sock.sendMessage(from, { text: '❌ Format salah. Contoh:\n/tambah Matematika\n\nAtau langsung dengan deadline:\n/tambah Matematika - 18/06/2026 23:59' });
                }

                const parsedTasks = parseTaskLines(body);
                if (parsedTasks.length === 0) {
                    return await sock.sendMessage(from, { text: '❌ Tidak ada tugas valid. Contoh: `/tambah Matematika`' });
                }

                // ── Flowchart: cari emailnya, bisa akses kalender? ──
                const email = getUserEmail(from);
                const bisaAkses = email ? await canAccessCalendar(email) : false;

                if (!bisaAkses) {
                    // N → kasih pesan "harus konek"
                    return await sock.sendMessage(from, { text: pesanHarusKonek(email) });
                }

                // Y → langsung catet ke kalender google
                const db = readDB();
                const responseList = [];
                const savedTasks = [];
                const gagalList = [];

                for (const t of parsedTasks) {
                    let eventId;
                    try {
                        eventId = await addTaskToCalendar(email, { nama: t.nama, deadline: t.deadline, time: t.time });
                    } catch (error) {
                        console.error(`[Calendar] Gagal mencatat "${t.nama}":`, error.message);
                        gagalList.push(t.nama);
                        continue;
                    }

                    const newTask = {
                        id: uuidv4(),
                        nama: t.nama,
                        deadline: t.deadline,
                        deadlineTime: t.time,
                        owner: from,
                        status: 'aktif',
                        reminded: false,
                        calendarEventId: eventId,
                        createdAt: moment().toISOString()
                    };
                    db.push(newTask);
                    savedTasks.push(newTask);
                    responseList.push(`${savedTasks.length}. *${t.nama}*\n   📅 Deadline: ${formatDeadline(newTask)}` +
                        (t.deadline ? `\n   ⏰ Pengingat: ${formatReminderDate(t.deadline)}` : ''));
                }

                if (savedTasks.length === 0) {
                    return await sock.sendMessage(from, { text: '🚨 Gagal mencatat ke Google Calendar. Coba lagi beberapa saat.' });
                }

                writeDB(db);
                const totalAktif = db.filter(t => t.owner === from && t.status === 'aktif').length;
                const catatanGagal = gagalList.length > 0
                    ? `\n\n⚠️ Gagal dicatat ke kalender: ${gagalList.join(', ')}`
                    : '';

                await sock.sendMessage(from, { text: `✅ Berhasil dicatat ke Google Calendar!\n\n📚 *Daftar Tugas Baru*\n\n${responseList.join('\n\n')}\n\n🗂 Total tugas aktif: ${totalAktif}${catatanGagal}` });

                // Tugas yang sudah lengkap langsung dikirimi pengingat awal
                savedTasks.filter(t => t.deadline).forEach(t => kirimPengingatAwal(sock, from, t));

                // Tanyain juga tanggal sama jam deadlinenya kapan
                const pending = savedTasks.filter(t => !t.deadline);
                if (pending.length > 0) {
                    await tanyaDeadline(sock, from, pending[0], pending.length - 1);
                }
            }

            else if (command === '/batal') {
                const db = readDB();
                const pending = getPendingTasks(db, from);

                if (pending.length === 0) {
                    return await sock.sendMessage(from, { text: '📢 Tidak ada tugas yang menunggu deadline.' });
                }

                const email = getUserEmail(from);
                for (const t of pending) {
                    try {
                        await deleteCalendarEvent(email, t.calendarEventId);
                    } catch (error) {
                        console.error(`[Calendar] Gagal menghapus event "${t.nama}":`, error.message);
                    }
                }

                const idsBatal = new Set(pending.map(t => t.id));
                writeDB(db.filter(t => !idsBatal.has(t.id)));
                await sock.sendMessage(from, { text: `🗑️ ${pending.length} tugas tanpa deadline dibatalkan dan dihapus dari kalender.` });
            }

            else if (command === '/lihat') {
                const db = readDB();
                const userTasks = db.filter(t => t.owner === from && t.status === 'aktif');

                if (userTasks.length === 0) {
                    return await sock.sendMessage(from, { text: '🎉 Tidak ada tugas aktif saat ini. Kerja bagus!' });
                }

                const responseList = userTasks.map((t, index) => `${index + 1}. *${t.nama}*\n   Deadline: ${formatDeadline(t)}`);
                await sock.sendMessage(from, { text: `📚 *Tugas Aktif Kamu*\n\n${responseList.join('\n\n')}` });
            }

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

            else if (command === '/sticker') {
                const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;

                if (!quoted) {
                    return await sock.sendMessage(from, { text: '❌ Harus reply gambar terlebih dahulu!\n\nCara:\n1. Reply gambar dengan `/sticker`\n\n*Contoh:* Balas sticker dengan reply gambar' });
                }

                const imageMessage = quoted.imageMessage;
                if (!imageMessage) {
                    return await sock.sendMessage(from, { text: '❌ Pesan yang di-reply harus berupa gambar!' });
                }

                try {
                    await sock.sendMessage(from, { text: '⏳ Sedang mengonversi gambar menjadi sticker...' });

                    const stream = await downloadContentFromMessage(imageMessage, 'image');
                    let buffer = Buffer.from([]);

                    for await (const chunk of stream) {
                        buffer = Buffer.concat([buffer, chunk]);
                    }

                    await sock.sendMessage(from, {
                        sticker: buffer
                    });

                    console.log(`[Sticker] Sticker berhasil dibuat dari image`);
                } catch (error) {
                    console.error('Error sticker:', error);
                    await sock.sendMessage(from, { text: '🚨 Gagal mengkonversi gambar menjadi sticker. Coba lagi!' });
                }
            }

            else if (command === '/restart') {
                if (!isOwner) {
                    return await sock.sendMessage(from, { text: '❌ Perintah ini rahasia dan hanya bisa dijalankan oleh pemilik bot!' });
                }

                await sock.sendMessage(from, { text: '🔄 Server memproses pembaruan via GitHub. Bot akan menyala kembali dalam 5 detik...' });
                console.log('[System] Menutup proses Node untuk memicu restart skrip panel...');

                setTimeout(() => { process.exit(0); }, 1000);
            }

        } catch (error) {
            console.error('Error:', error);
            await sock.sendMessage(from, { text: '🚨 Terjadi kesalahan internal sistem saat memproses perintah.' });
        }
    });
}

startBot();