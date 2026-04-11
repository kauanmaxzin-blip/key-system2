// ╔══════════════════════════════════════════════════════════════╗
// ║   KAUAN XIT · KEY SERVER  v3.0                               ║
// ║   + Lock por conta (userId)  |  Deploy: Render / Railway     ║
// ╚══════════════════════════════════════════════════════════════╝

const express = require("express");
const fs      = require("fs");

const app = express();
app.use(express.json());

// ── CONFIGURAÇÕES ─────────────────────────────────────────────
const DB_FILE        = "keys.json";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "kauanxit_admin_2026";
const PORT           = process.env.PORT || 3000;

// ── BANCO DE DADOS ────────────────────────────────────────────
function loadDB() {
    if (!fs.existsSync(DB_FILE)) return {};
    try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
    catch { return {}; }
}
function saveDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ── GERADOR DE CÓDIGO  (ex: 7B4-8P9-8HP) ─────────────────────
function gerarCodigo() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let cod = "";
    for (let s = 0; s < 3; s++) {
        if (s > 0) cod += "-";
        for (let c = 0; c < 3; c++)
            cod += chars[Math.floor(Math.random() * chars.length)];
    }
    return cod;
}

// ═══════════════════════════════════════════════════════════════
//  ROTAS
// ═══════════════════════════════════════════════════════════════

// ── [ADMIN] Gerar nova key ────────────────────────────────────
app.post("/generate", (req, res) => {
    const { password, days = 7, quantity = 1 } = req.body;

    if (password !== ADMIN_PASSWORD)
        return res.json({ success: false, error: "Senha de admin incorreta!" });

    const qtd       = Math.min(Math.max(parseInt(quantity) || 1, 1), 100);
    const db        = loadDB();
    const geradas   = [];
    const durationMs = (parseFloat(days) || 7) * 24 * 60 * 60 * 1000;

    for (let i = 0; i < qtd; i++) {
        let codigo, tentativas = 0;
        do { codigo = gerarCodigo(); tentativas++; }
        while (db[codigo] && tentativas < 50);

        db[codigo] = {
            createdAt:    Date.now(),
            durationMs,
            days:         parseFloat(days) || 7,
            activatedAt:  null,
            expiresAt:    null,
            lockedUserId: null,   // 🔒 será travado no 1º uso
        };
        geradas.push(codigo);
    }

    saveDB(db);
    console.log(`[GENERATE] ${qtd} key(s):`, geradas);
    res.json({ success: true, keys: geradas });
});

// ── [SCRIPT] Validar / Ativar key ────────────────────────────
//  Body: { "key": "7B4-8P9-8HP", "userId": "123456789" }
app.post("/validate", (req, res) => {
    const key    = (req.body.key    || "").trim().toUpperCase();
    const userId = String(req.body.userId || "").trim();

    if (!key)    return res.json({ valid: false, message: "Key não enviada!" });
    if (!userId) return res.json({ valid: false, message: "UserId não enviado!" });

    const db    = loadDB();
    const entry = db[key];

    if (!entry)
        return res.json({ valid: false, message: "Key falsa ou não gerada pelo servidor!" });

    const now = Date.now();

    // ── 1ª vez: ativa, inicia timer e trava na conta
    if (!entry.activatedAt) {
        entry.activatedAt  = now;
        entry.expiresAt    = now + entry.durationMs;
        entry.lockedUserId = userId;
        saveDB(db);
        console.log(`[ACTIVATE] Key ${key} ativada por userId=${userId}. Expira em ${entry.days}d.`);
    }

    // ── Bloqueia outra conta tentando usar a mesma key
    if (entry.lockedUserId && entry.lockedUserId !== userId) {
        console.log(`[BLOCKED] Key ${key} de userId=${entry.lockedUserId} tentada por userId=${userId}`);
        return res.json({ valid: false, message: "Essa Key já pertence a outra conta!" });
    }

    // ── Verifica expiração
    if (!entry.expiresAt || now > entry.expiresAt) {
        console.log(`[EXPIRED] Key ${key} expirada.`);
        return res.json({ valid: false, message: "Key expirada!" });
    }

    const remainingMs   = entry.expiresAt - now;
    const remainingDays = Math.floor(remainingMs / (1000 * 60 * 60 * 24));
    const remainingHrs  = Math.floor((remainingMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

    console.log(`[VALID] Key ${key} ok | userId=${userId} | Restam ${remainingDays}d ${remainingHrs}h`);

    res.json({
        valid: true,
        message: "Key válida! Bem-vindo(a).",
        expiresAt: entry.expiresAt,
        remainingDays,
        remainingHrs,
    });
});

// ── [ADMIN] Listar keys ───────────────────────────────────────
app.post("/list", (req, res) => {
    if (req.body.password !== ADMIN_PASSWORD)
        return res.json({ success: false, error: "Senha incorreta!" });

    const db  = loadDB();
    const now = Date.now();
    const lista = Object.entries(db).map(([codigo, e]) => ({
        key:    codigo,
        status: !e.activatedAt ? "aguardando" : (now > e.expiresAt ? "expirada" : "ativa"),
        days:   e.days,
        userId: e.lockedUserId || "-",
        expiresAt: e.expiresAt ? new Date(e.expiresAt).toLocaleString("pt-BR") : null,
    }));
    res.json({ success: true, total: lista.length, keys: lista });
});

// ── [ADMIN] Deletar key ───────────────────────────────────────
app.post("/delete", (req, res) => {
    const { password, key } = req.body;
    if (password !== ADMIN_PASSWORD)
        return res.json({ success: false, error: "Senha incorreta!" });

    const db = loadDB();
    const k  = (key || "").trim().toUpperCase();
    if (!db[k]) return res.json({ success: false, error: "Key não encontrada!" });
    delete db[k];
    saveDB(db);
    res.json({ success: true, message: `Key ${k} deletada.` });
});

// ── Health check ──────────────────────────────────────────────
app.get("/", (req, res) => res.send("✅ Kauan Xit Key Server v3.0 online!"));

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n🔑 Kauan Xit Key Server v3.0 rodando na porta ${PORT}`);
    console.log(`   Admin Password: ${ADMIN_PASSWORD}`);
    console.log(`   Banco de dados: ${DB_FILE}\n`);
});
