import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(__dirname, '../database/tasks.json');
const usersPath = path.resolve(__dirname, '../database/users.json');

// Memastikan file database dan folder tersedia
if (!fs.existsSync(path.dirname(dbPath))) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}
if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(dbPath, JSON.stringify([], null, 2), 'utf-8');
}
if (!fs.existsSync(usersPath)) {
    fs.writeFileSync(usersPath, JSON.stringify({}, null, 2), 'utf-8');
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

/**
 * Mengambil email Google yang dikonekkan user (JID WhatsApp -> email)
 * @param {string} jid
 * @returns {string|null}
 */
export const getUserEmail = (jid) => {
    try {
        const users = JSON.parse(fs.readFileSync(usersPath, 'utf-8'));
        return users[jid]?.email || null;
    } catch (error) {
        console.error("Gagal membaca data user:", error);
        return null;
    }
};

/**
 * Menyimpan email Google untuk sebuah JID WhatsApp
 * @param {string} jid
 * @param {string} email
 */
export const setUserEmail = (jid, email) => {
    try {
        const users = JSON.parse(fs.readFileSync(usersPath, 'utf-8'));
        users[jid] = { email, updatedAt: new Date().toISOString() };
        fs.writeFileSync(usersPath, JSON.stringify(users, null, 2), 'utf-8');
    } catch (error) {
        console.error("Gagal menulis data user:", error);
    }
};
