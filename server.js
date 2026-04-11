// ╔══════════════════════════════════════════════════════════════╗
// ║         KAUAN XIT - SERVIDOR DE KEYS ONLINE                  ║
// ║         Node.js + Express  |  Deploy: Railway / Render       ║
// ╚══════════════════════════════════════════════════════════════╝
//
// COMO USAR:
//   1. npm install
//   2. Defina a variável de ambiente ADMIN_PASSWORD (ou troque abaixo)
//   3. npm start
//   4. Copie a URL pública e coloque em SERVER_URL nos scripts Lua

const express = require("express");
const fs      = require("fs");

const app = express();
app.use(express.json());

// ── CONFIGURAÇÕES ─────────────────────────────────────────────
const DB_FILE       = "keys.json";          // banco de dados simples
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "kauanxit_admin_2026";
const PORT          = process.env.PORT || 3000;

// ── BANCO DE DADOS (arquivo JSON) ─────────────────────────────
function loadDB() {
    if (!fs.existsSync(DB_FILE)) return {};
    try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
    catch { return {}; }
}
function saveDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ── GERADOR DE CÓDIGO  (formato: 7B4-8P9-8HP) ─────────────────
function gerarCodigo() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sem 0,O,1,I (confusos)
    let cod = "";
    for (let seg = 0; seg < 3; seg++) {
        if (seg > 0) cod += "-";
        for (let c = 0; c < 3; c++) {
            cod += chars[Math.floor(Math.random() * chars.length)];
        }
    }
    return cod;
}

// ═══════════════════════════════════════════════════════════════
//  ROTAS
// ═══════════════════════════════════════════════════════════════

// ── [ADMIN] Gerar nova key ────────────────────────────────────
//  POST /generate
//  Body: { "password": "...", "days": 7, "quantity": 1 }
app.post("/generate", (req, res) => {
    const { password, days = 7, quantity = 1 } = req.body;

    if (password !== ADMIN_PASSWORD) {
        return res.json({ success: false, error: "Senha de admin incorreta!" });
    }

    const qtd = Math.min(Math.max(parseInt(quantity) || 1, 1), 100);
    const db  = loadDB();
    const geradas = [];
    const durationMs = (parseFloat(days) || 7) * 24 * 60 * 60 * 1000;

    for (let i = 0; i < qtd; i++) {
        let codigo;
        let tentativas = 0;
        do { codigo = gerarCodigo(); tentativas++; }
        while (db[codigo] && tentativas < 50); // garante unicidade

        db[codigo] = {
            createdAt:    Date.now(),
            durationMs:   durationMs,
            days:         parseFloat(days) || 7,
            activatedAt:  null,   // null = ainda não foi usada
            expiresAt:    null,   // começa a contar só na 1ª validação
        };
        geradas.push(codigo);
    }

    saveDB(db);
    console.log(`[GENERATE] ${qtd} key(s) criada(s):`, geradas);
    res.json({ success: true, keys: geradas });
});

// ── [SCRIPT] Validar / Ativar key ────────────────────────────
//  POST /validate
//  Body: { "key": "7B4-8P9-8HP" }
app.post("/validate", (req, res) => {
    const key = (req.body.key || "").trim().toUpperCase();
    if (!key) return res.json({ valid: false, message: "Key não enviada!" });

    const db    = loadDB();
    const entry = db[key];

    if (!entry) {
        return res.json({ valid: false, message: "Key falsa ou não gerada pelo servidor!" });
    }

    const now = Date.now();

    // ── Primeira vez sendo usada: ativa e inicia o temporizador
    if (!entry.activatedAt) {
        entry.activatedAt = now;
        entry.expiresAt   = now + entry.durationMs;
        saveDB(db);
        console.log(`[ACTIVATE] Key ${key} ativada. Expira em ${entry.days} dia(s).`);
    }

    // ── Verifica expiração
    if (now > entry.expiresAt) {
        console.log(`[EXPIRED] Key ${key} expirada.`);
        return res.json({ valid: false, message: "Key expirada!" });
    }

    const remainingMs   = entry.expiresAt - now;
    const remainingDays = Math.floor(remainingMs / (1000 * 60 * 60 * 24));
    const remainingHrs  = Math.floor((remainingMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

    console.log(`[VALID] Key ${key} validada. Restam ${remainingDays}d ${remainingHrs}h`);

    res.json({
        valid:        true,
        message:      "Key válida! Bem-vindo(a).",
        expiresAt:    entry.expiresAt,          // timestamp em ms (dividir por 1000 no Lua)
        remainingDays,
        remainingHrs,
        firstUse:     (entry.activatedAt === now), // true se acabou de ativar agora
    });
});

// ── [ADMIN] Listar keys ───────────────────────────────────────
//  POST /list
//  Body: { "password": "..." }
app.post("/list", (req, res) => {
    if (req.body.password !== ADMIN_PASSWORD) {
        return res.json({ success: false, error: "Senha incorreta!" });
    }
    const db = loadDB();
    const now = Date.now();
    const lista = Object.entries(db).map(([codigo, entry]) => ({
        key:       codigo,
        status:    !entry.activatedAt ? "aguardando" :
                   (now > entry.expiresAt ? "expirada" : "ativa"),
        days:      entry.days,
        expiresAt: entry.expiresAt
            ? new Date(entry.expiresAt).toLocaleString("pt-BR")
            : null,
    }));
    res.json({ success: true, total: lista.length, keys: lista });
});

// ── [ADMIN] Deletar key ───────────────────────────────────────
//  POST /delete
//  Body: { "password": "...", "key": "7B4-8P9-8HP" }
app.post("/delete", (req, res) => {
    const { password, key } = req.body;
    if (password !== ADMIN_PASSWORD) {
        return res.json({ success: false, error: "Senha incorreta!" });
    }
    const db = loadDB();
    const k  = (key || "").trim().toUpperCase();
    if (!db[k]) return res.json({ success: false, error: "Key não encontrada!" });
    delete db[k];
    saveDB(db);
    res.json({ success: true, message: `Key ${k} deletada.` });
});

// ── Health check ──────────────────────────────────────────────
app.get("/", (req, res) => res.send("✅ Kauan Xit Key Server online!"));

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n🔑 Kauan Xit Key Server rodando na porta ${PORT}`);
    console.log(`   Admin Password: ${ADMIN_PASSWORD}`);
    console.log(`   Banco de dados: ${DB_FILE}\n`);
});
