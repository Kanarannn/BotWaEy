import cron from 'node-cron';
import moment from 'moment';
import { readDB, writeDB } from './database.js';

/**
 * Menjalankan scheduler pengecekan tugas setiap jam
 * @param {import('@whiskeysockets/baileys').WASocket} sock 
 */
export const initScheduler = (sock) => {
    // Berjalan setiap jam pada menit ke-0 (0 * * * *)
    cron.schedule('0 * * * *', async () => {
        console.log('[Scheduler] Memeriksa tugas untuk pengingat H-1...');
        try {
            const db = readDB();
            let isUpdated = false;
            const hariIni = moment().format('YYYY-MM-DD');

            for (let task of db) {
                // Syarat: Status aktif, belum diingatkan, dan hari ini adalah H-1 deadline
                const tanggalReminder = moment(task.deadline, 'YYYY-MM-DD').subtract(1, 'days').format('YYYY-MM-DD');

                if (task.status === 'aktif' && !task.reminded && hariIni === tanggalReminder) {
                    const deadlineDisplay = moment(task.deadline, 'YYYY-MM-DD').format('D MMMM YYYY');
                    
                    const pesanAlert = `⏰ *PENGINGAT TUGAS*\n\n📚 *${task.nama}*\n\n📅 Deadline: *Besok*\n(${deadlineDisplay})\n\nSegera selesaikan tugas sebelum batas waktu.`;
                    
                    // Mengirim pesan ke pemilik tugas
                    await sock.sendMessage(task.owner, { text: pesanAlert });
                    
                    // Update status reminded
                    task.reminded = true;
                    isUpdated = true;
                    console.log(`[Scheduler] Pengingat terkirim untuk tugas: ${task.nama} ke ${task.owner}`);
                }
            }

            if (isUpdated) {
                writeDB(db);
            }
        } catch (error) {
            console.error('[Scheduler Error]:', error);
        }
    });
};