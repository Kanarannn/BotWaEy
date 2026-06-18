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
    return moment(dateStr, 'YYYY-MM-DD').format('D MMMM YYYY');
};

export const formatReminderDate = (dateStr) => {
    return moment(dateStr, 'YYYY-MM-DD').subtract(1, 'days').format('D MMMM YYYY');
};