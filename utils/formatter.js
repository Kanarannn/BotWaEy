import moment from 'moment';
moment.locale('id'); 

/**
 * Memparsing input teks baris demi baris menjadi objek tugas
 * @param {string} text 
 * @returns {Array} array dari objek nama dan deadline (YYYY-MM-DD)
 */
export const parseTasksInput = (text) => {
    // Bersihkan perintah /tambah di awal teks jika ada
    const cleanText = text.replace(/^\/tambah\s*/i, '');
    const lines = cleanText.split('\n');
    const tasks = [];

    for (let line of lines) {
        line = line.trim();
        if (!line) continue;

        const parts = line.split('-');
        if (parts.length < 2) continue;

        // Mengambil nama tugas (mendukung nama tugas yang punya tanda strip di dalamnya)
        const nama = parts.slice(0, -1).join('-').trim();
        const dateStr = parts[parts.length - 1].trim();

        // Validasi format tanggal DD/MM/YYYY
        const parsedDate = moment(dateStr, 'DD/MM/YYYY', true);
        if (parsedDate.isValid()) {
            tasks.push({
                nama,
                deadline: parsedDate.format('YYYY-MM-DD')
            });
        }
    }
    return tasks;
};

export const formatDisplayDate = (dateStr) => {
    if (!dateStr) return 'belum diisi';
    return moment(dateStr, 'YYYY-MM-DD').format('D MMMM YYYY');
};

/**
 * Tanggal + jam deadline sebuah tugas untuk ditampilkan
 * @param {{deadline: string|null, deadlineTime?: string|null}} task
 */
export const formatDeadline = (task) => {
    const tanggal = formatDisplayDate(task.deadline);
    return task.deadline && task.deadlineTime ? `${tanggal}, ${task.deadlineTime} WIB` : tanggal;
};

/**
 * Parse "DD/MM/YYYY" atau "DD/MM/YYYY HH:mm" (jam boleh pakai titik, mis. 23.59)
 * @param {string} text
 * @returns {{deadline: string, time: string|null}|null} deadline = YYYY-MM-DD, time = HH:mm / null
 */
export const parseDeadlineReply = (text) => {
    const m = text.trim().match(/^(\d{1,2}\/\d{1,2}\/\d{4})(?:\s+(?:jam\s+)?(\d{1,2})[:.](\d{2}))?$/i);
    if (!m) return null;

    const tanggal = moment(m[1], ['D/M/YYYY', 'DD/MM/YYYY'], true);
    if (!tanggal.isValid()) return null;

    let time = null;
    if (m[2] !== undefined) {
        const jam = parseInt(m[2], 10);
        const menit = parseInt(m[3], 10);
        if (jam > 23 || menit > 59) return null;
        time = `${String(jam).padStart(2, '0')}:${String(menit).padStart(2, '0')}`;
    }

    return { deadline: tanggal.format('YYYY-MM-DD'), time };
};

/**
 * Parse argumen /tambah, satu tugas per baris.
 *  - "Nama Tugas"                         -> deadline null (bot tanya kemudian)
 *  - "Nama Tugas - DD/MM/YYYY [HH:mm]"    -> deadline langsung terisi
 * @param {string} text
 * @returns {Array<{nama: string, deadline: string|null, time: string|null}>}
 */
export const parseTaskLines = (text) => {
    const cleanText = text.replace(/^\/tambah\s*/i, '');
    const tasks = [];

    for (let line of cleanText.split('\n')) {
        line = line.trim();
        if (!line) continue;

        const idx = line.lastIndexOf(' - ');
        if (idx > 0) {
            const parsed = parseDeadlineReply(line.slice(idx + 3));
            const nama = line.slice(0, idx).trim();
            if (parsed && nama) {
                tasks.push({ nama, deadline: parsed.deadline, time: parsed.time });
                continue;
            }
        }
        tasks.push({ nama: line, deadline: null, time: null });
    }
    return tasks;
};

export const formatReminderDate = (dateStr) => {
    return moment(dateStr, 'YYYY-MM-DD').subtract(1, 'days').format('D MMMM YYYY');
};