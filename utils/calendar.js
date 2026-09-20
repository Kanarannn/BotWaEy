import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import moment from 'moment';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Lokasi file JSON service account (JANGAN di-commit ke GitHub)
const KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_FILE
    || path.resolve(__dirname, '../credentials/service-account.json');

const TIME_ZONE = process.env.CALENDAR_TIMEZONE || 'Asia/Jakarta';

let calendarClient = null;

const getClient = () => {
    if (calendarClient) return calendarClient;
    if (!fs.existsSync(KEY_FILE)) {
        console.error(`[Calendar] File service account tidak ditemukan: ${KEY_FILE}`);
        return null;
    }
    const auth = new google.auth.GoogleAuth({
        keyFile: KEY_FILE,
        scopes: ['https://www.googleapis.com/auth/calendar']
    });
    calendarClient = google.calendar({ version: 'v3', auth });
    return calendarClient;
};

/**
 * Email service account bot. User harus share kalendernya ke email ini.
 * @returns {string|null}
 */
export const getServiceAccountEmail = () => {
    try {
        return JSON.parse(fs.readFileSync(KEY_FILE, 'utf-8')).client_email || null;
    } catch {
        return null;
    }
};

/**
 * Node "cari emailnya bisa akses kalender" di flowchart.
 * True kalau service account bot punya izin tulis (writer/owner) ke kalender email tsb.
 * @param {string} email
 * @returns {Promise<boolean>}
 */
export const canAccessCalendar = async (email) => {
    const calendar = getClient();
    if (!calendar || !email) return false;

    try {
        let entry;
        try {
            entry = await calendar.calendarList.get({ calendarId: email });
        } catch (err) {
            // Kalender yang di-share belum otomatis muncul di calendarList service account
            if (err.code !== 404) throw err;
            entry = await calendar.calendarList.insert({ requestBody: { id: email } });
        }
        return ['writer', 'owner'].includes(entry.data.accessRole);
    } catch (error) {
        console.log(`[Calendar] ${email} tidak bisa diakses: ${error.code || error.message}`);
        return false;
    }
};

/**
 * Susun body event Google Calendar.
 *  - deadline null       : placeholder all-day hari ini (deadline belum diisi)
 *  - deadline tanpa jam  : all-day di tanggal deadline
 *  - deadline + jam      : event 30 menit mulai jam deadline (zona waktu Asia/Jakarta)
 */
const buildEventBody = (nama, deadline, time) => {
    if (!deadline) {
        const hariIni = moment().format('YYYY-MM-DD');
        return {
            summary: `📚 ${nama} (deadline belum diisi)`,
            description: 'Deadline belum diisi. Dicatat otomatis oleh Bot Tugas.',
            start: { date: hariIni },
            end: { date: moment(hariIni, 'YYYY-MM-DD').add(1, 'days').format('YYYY-MM-DD') },
            reminders: { useDefault: false, overrides: [] }
        };
    }

    const body = {
        summary: `📚 ${nama}`,
        description: `Deadline tugas: ${nama}\nDicatat otomatis oleh Bot Tugas.`
    };

    if (!time) {
        body.start = { date: deadline };
        body.end = { date: moment(deadline, 'YYYY-MM-DD').add(1, 'days').format('YYYY-MM-DD') };
        // 900 menit sebelum 00:00 hari deadline = jam 09:00 H-1
        body.reminders = { useDefault: false, overrides: [{ method: 'popup', minutes: 900 }] };
    } else {
        const mulai = moment.utc(`${deadline} ${time}`, 'YYYY-MM-DD HH:mm');
        body.start = { dateTime: mulai.format('YYYY-MM-DDTHH:mm:00'), timeZone: TIME_ZONE };
        body.end = { dateTime: mulai.clone().add(30, 'minutes').format('YYYY-MM-DDTHH:mm:00'), timeZone: TIME_ZONE };
        body.reminders = {
            useDefault: false,
            overrides: [{ method: 'popup', minutes: 1440 }, { method: 'popup', minutes: 60 }]
        };
    }
    return body;
};

/**
 * Node "langsung catet ke kalender google" di flowchart.
 * @param {string} email
 * @param {{nama: string, deadline?: string|null, time?: string|null}} task deadline format YYYY-MM-DD, time HH:mm
 * @returns {Promise<string>} ID event Google Calendar
 */
export const addTaskToCalendar = async (email, { nama, deadline = null, time = null }) => {
    const calendar = getClient();
    if (!calendar) throw new Error('Service account belum dikonfigurasi');

    const res = await calendar.events.insert({
        calendarId: email,
        requestBody: buildEventBody(nama, deadline, time)
    });
    return res.data.id;
};

/**
 * Node "tanyain juga tanggal sama jam deadlinenya kapan": isi deadline pada event yang sudah dicatat.
 * @param {string} email
 * @param {string} eventId
 * @param {string} nama
 * @param {string} deadline YYYY-MM-DD
 * @param {string|null} time HH:mm
 */
export const updateEventDeadline = async (email, eventId, nama, deadline, time) => {
    const calendar = getClient();
    if (!calendar) throw new Error('Service account belum dikonfigurasi');

    await calendar.events.update({
        calendarId: email,
        eventId,
        requestBody: buildEventBody(nama, deadline, time)
    });
};

/**
 * Hapus event (dipakai saat /batal)
 */
export const deleteCalendarEvent = async (email, eventId) => {
    const calendar = getClient();
    if (!calendar) throw new Error('Service account belum dikonfigurasi');
    await calendar.events.delete({ calendarId: email, eventId });
};
