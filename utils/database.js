import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(__dirname, '../database/tasks.json');

// Memastikan file database dan folder tersedia
if (!fs.existsSync(path.dirname(dbPath))) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}
if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(dbPath, JSON.stringify([], null, 2), 'utf-8');
}

/**
 * Membaca seluruh data tugas dari JSON
 * @returns {Array} List of tasks
 */
export const readDB = () => {
    try {
        const data = fs.readFileSync(dbPath, 'utf-8');
        return JSON.stringify(data) === '{}' ? [] : JSON.parse(data);
    } catch (error) {
        console.error("Gagal membaca database:", error);
        return [];
    }
};

/**
 * Menulis data tugas kembali ke JSON
 * @param {Array} data 
 */
export const writeDB = (data) => {
    try {
        fs.writeFileSync(dbPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
        console.error("Gagal menulis ke database:", error);
    }
};