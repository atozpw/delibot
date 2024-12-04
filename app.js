require('dotenv').config();

const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const mysql = require("mysql2/promise");

const APP_NAME = process.env.APP_NAME;
const CLIENT_ID = process.env.CLIENT_ID;

const client = new Client({
    authStrategy: new LocalAuth({
        clientId: CLIENT_ID,
    }),
    puppeteer: {
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-accelerated-2d-canvas",
            "--no-first-run",
            "--no-zygote",
            "--single-process",
            "--disable-gpu",
        ],
    },
});

const connection = async () => {
    return await mysql.createConnection({
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        user: process.env.DB_USERNAME,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_DATABASE,
    });
};

const startSession = async (from) => {
    const db = await connection();
    await db.execute("INSERT INTO `wa_sessions` (`from`, `expired_at`) VALUES (?, UNIX_TIMESTAMP() + (60 * 60 * 12))", [from]);
    await db.end();
};

const getSession = async (from) => {
    const db = await connection();
    const [rows] = await db.query("SELECT `id` FROM `wa_sessions` WHERE `from` = ? AND `expired_at` > UNIX_TIMESTAMP() ORDER BY `expired_at` DESC LIMIT 1", [from]);
    await db.end();
    return rows[0] || false;
};

const getCustomer = async (id) => {
    const db = await connection();
    const [rows] = await db.query("SELECT a.pel_no, a.pel_nama, a.pel_alamat, b.kps_ket FROM tm_pelanggan a JOIN tr_kondisi_ps b ON b.kps_kode = a.kps_kode WHERE a.pel_no = ?", [id]);
    await db.end();
    return rows[0] || false;
};

const getBills = async (id) => {
    const db = await connection();
    const [rows] = await db.query("SELECT rek_thn, rek_bln, rek_stankini - rek_stanlalu AS rek_pakai, rek_uangair, rek_adm + rek_meter AS rek_beban, getDenda(rek_total, rek_bln, rek_thn) AS rek_denda, getDenda(rek_total, rek_bln, rek_thn) + rek_total AS rek_total FROM tm_rekening WHERE rek_sts = 1 AND rek_byr_sts = 0 AND pel_no = ?", [id]);
    await db.end();
    return rows || false;
};

const monthFormatter = (value) => {
    const month = ["", "Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
    let formatted = month[value];
    return formatted;
};

const rupiahFormatter = (number) => {
    let tempNum = String(number).split("").reverse();
    let formatted = "";
    for (let i = 0; i < tempNum.length; i++) {
        if ((i + 1) % 3 == 0 && i != tempNum.length - 1) {
            tempNum[i] = `.${tempNum[i]}`;
        }
    }
    formatted = `Rp. ${tempNum.reverse().join("")}`;
    return formatted;
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

client.once("ready", () => {
    console.log(`${APP_NAME} with Client ID ${CLIENT_ID} is ready!`);
});

client.on("qr", (qr) => {
    qrcode.generate(qr, { small: true });
});

client.on("message", async (message) => {
    const session = await getSession(message.from);

    if (!session) {
        const chat = await message.getChat();
        chat.sendStateTyping();

        let reply = "Selamat datang di WA Chatbot Tagihan Perumda Air Minum Tirta Deli, Saya akan membantu Anda melakukan cek tagihan secara mandiri via Chat Only. Sekarang, cek tagihan dapat dilakukan secara mandiri via WhatsApp dengan ketik format keyword sebagai berikut :\n"
        reply += "- Tagihan#NomorPelanggan\n\n";
        reply += "Contoh :\n";
        reply += "- Tagihan#12345678\n\n";
        reply += "Note :\n";
        reply += "- Pastikan kembali keyword Anda sudah benar.\n";
        reply += "- Robot tidak dapat merespon yang bukan keyword.\n";
        reply += "- Untuk layanan Hubungan Langganan : 0812-6974-6240";

        await sleep(3000);
        chat.clearState();
        client.sendMessage(message.from, reply);

        await startSession(message.from);
        console.log(`Start session from ${message.from}`);
    }
    else if (session && message.body.toLowerCase().startsWith("tagihan#")) {
        const chat = await message.getChat();
        chat.sendStateTyping();

        await sleep(1000);
        chat.clearState();
        client.sendMessage(message.from, "Saya akan melakukan pencarian, mohon tunggu...");
        console.log(`Searching from ${message.from} with message ${message.body}`);

        await sleep(1000);
        chat.sendStateTyping();

        const id = message.body.split("#")[1];
        const customer = await getCustomer(id);
        const bills = await getBills(id);

        let reply = "";
        let delay = 3000;

        if (customer) {
            reply += `Nomor: ${customer.pel_no}\n`;
            reply += `Nama Lengkap: ${customer.pel_nama}\n`;
            reply += `Alamat: ${customer.pel_alamat}\n`;
            reply += `Status: ${customer.kps_ket}\n`;
            reply += `\n`;
            reply += `*Rincian Tagihan:*\n`;

            if (bills.length > 0) {
                let i = 0;
                let grandTotal = 0;

                if (bills.length > 1) reply += `\n`;

                for (let bill of bills) {
                    if (i > 0) reply += `\n`;
                    reply += `Periode ${monthFormatter(bill.rek_bln)} ${bill.rek_thn}\n`;
                    reply += `Pemakaian: ${bill.rek_pakai} m3\n`;
                    reply += `Uang Air: ${rupiahFormatter(bill.rek_uangair)}\n`;
                    reply += `Beban Tetap: ${rupiahFormatter(bill.rek_beban)}\n`;
                    reply += `Denda: ${rupiahFormatter(bill.rek_denda)}\n`;
                    reply += `Total: ${rupiahFormatter(bill.rek_total)}\n`;
                    grandTotal += bill.rek_total;
                    i++;
                }

                reply += `\n`;
                reply += `*Total Tagihan: ${rupiahFormatter(grandTotal)}*`;
                delay = 6000;

                console.log(`Bill found from ${message.from} with message ${message.body}`);
            } else {
                reply += `Tidak ada tagihan`;
                console.log(`Bill not found from ${message.from} with message ${message.body}`);
            }
        } else {
            reply += `Mohon maaf, saya tidak dapat menemukan data tagihan dengan nomor pelanggan ${id}.`;
            console.log(`Customer not found from ${message.from} with message ${message.body}`);
        }

        await sleep(delay);
        chat.clearState();
        client.sendMessage(message.from, reply);
    }
    else {
        const chat = await message.getChat();
        chat.sendStateTyping();

        let reply = "Mohon maaf, saya tidak mengerti keyword tersebut. Untuk cek tagihan, Anda bisa menggunakan keyword Tagihan#NomorPelanggan.\n\n";
        reply += "Contoh :\n";
        reply += "Tagihan#12345678";

        await sleep(3000);
        chat.clearState();
        client.sendMessage(message.from, reply);

        console.log(`Keyword not found from ${message.from} with message ${message.body}`);
    }
});

client.initialize();
