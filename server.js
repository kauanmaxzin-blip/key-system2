// ╔══════════════════════════════════════════════════════════════╗
// ║   KAUAN XIT · KEY SERVER  v5.4  (Upstash Redis)             ║
// ║   Sistema Antifalhas de Validação (Ignora espaços/letras)   ║
// ╚══════════════════════════════════════════════════════════════╝

const express = require("express");
const https   = require("https");
const fs      = require("fs");
const path    = require("path");
const cors    = require("cors"); 
const app     = express();

app.use(express.json());
app.use(cors());

const ADMIN_PASSWORD  = process.env.ADMIN_PASSWORD  || "kauanxit_admin_2026";
const UPSTASH_URL     = process.env.UPSTASH_URL     || "";
const UPSTASH_TOKEN   = process.env.UPSTASH_TOKEN   || "";
const PORT            = process.env.PORT || 3000;

// ── UPSTASH: executar comando Redis via REST ──────────────────
function redis(command) {
    return new Promise((resolve) => {
        if (!UPSTASH_URL || !UPSTASH_TOKEN) return resolve(null);
        
        const body = JSON.stringify(command);
        const url  = new URL(UPSTASH_URL);
        const options = {
            hostname: url.hostname,
            path:     "/",
            method:   "POST",
            headers:  {
                "Authorization": "Bearer " + UPSTASH_TOKEN,
                "Content-Type":  "application/json",
                "Content-Length": Buffer.byteLength(body),
            }
        };
        const req = https.request(options, (res) => {
            let data = "";
            res.on("data", chunk => data += chunk);
            res.on("end", () => {
                try { resolve(JSON.parse(data).result); }
                catch { resolve(null); }
            });
        });
        req.on("error", () => resolve(null));
        req.write(body);
        req.end();
    });
}

async function getKey(key) {
    const val = await redis(["GET", "kx:" + key]);
    if (!val) return null;
    try { return JSON.parse(val); } catch { return null; }
}

async function setKey(key, data) {
    await redis(["SET", "kx:" + key, JSON.stringify(data)]);
}

async function getAllKeys() {
    const keys = await redis(["KEYS", "kx:*"]);
    if (!keys || keys.length === 0) return {};
    const result = {};
    for (const k of keys) {
        const val = await redis(["GET", k]);
        try { result[k.replace("kx:", "")] = JSON.parse(val); } catch {}
    }
    return result;
}

async function deleteKey(key) {
    await redis(["DEL", "kx:" + key]);
}

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

app.post("/generate", async (req, res) => {
    const { password, days = 7, quantity = 1, prefix = "", suffix = "", formatName = "Tradicional" } = req.body;
    
    if (password !== ADMIN_PASSWORD)
        return res.json({ success: false, error: "Senha de admin incorreta!" });

    const qtd        = Math.min(Math.max(parseInt(quantity) || 1, 1), 100);
    const geradas    = [];
    const durationMs = (parseFloat(days) || 7) * 24 * 60 * 60 * 1000;

    for (let i = 0; i < qtd; i++) {
        let codigoFinal, tentativas = 0;
        let existe;
        do {
            const codigoBase = gerarCodigo();
            codigoFinal = prefix + codigoBase + suffix;
            existe = await getKey(codigoFinal);
            tentativas++;
        } while (existe && tentativas < 50);

        await setKey(codigoFinal, {
            createdAt:    Date.now(),
            durationMs,
            days:         parseFloat(days) || 7,
            activatedAt:  null,
            expiresAt:    null,
            lockedUserId: null,
            formatName:   formatName 
        });
        geradas.push(codigoFinal);
    }

    console.log(`[GENERATE] ${qtd} key(s) do tipo ${formatName} geradas.`);
    res.json({ success: true, keys: geradas });
});

app.post("/validate", async (req, res) => {
    const keyInput = (req.body.key || "").trim();
    const userId   = String(req.body.userId || "").trim();

    if (!keyInput) return res.json({ valid: false, message: "Key nao enviada!" });
    if (!userId)   return res.json({ valid: false, message: "UserId nao enviado!" });

    // 1ª Tentativa: Busca exata
    let entry = await getKey(keyInput);
    let keyUsed = keyInput;

    // 2ª Tentativa: Busca forçando maiúsculo
    if (!entry) {
        entry = await getKey(keyInput.toUpperCase());
        if (entry) keyUsed = keyInput.toUpperCase();
    }

    // 3ª Tentativa: BUSCA ROBUSTA ANTIFALHAS
    // Isso resolve se o script remover os espaços, deixar minúsculo, 
    // ou não enviar o prefixo completo (ex: enviar só 9F3-PL4-FHL).
    if (!entry) {
        const db = await getAllKeys();
        // Remove todos os espaços e deixa maiúsculo para comparar
        const cleanInput = keyInput.toUpperCase().replace(/\s+/g, ''); 

        for (const [dbKey, dbEntry] of Object.entries(db)) {
            const cleanDbKey = dbKey.toUpperCase().replace(/\s+/g, '');
            
            const isExactMatch = (cleanDbKey === cleanInput);
            // Se o DB tem ZKXIT|3.0-ABC-DEF, e o script enviou só ABC-DEF
            const dbContainsInput = (cleanInput.length >= 8 && cleanDbKey.includes(cleanInput));
            // Se o DB tem só ABC-DEF, e o script enviou ZKXIT|3.0-ABC-DEF (caso de keys velhas)
            const inputContainsDb = (cleanDbKey.length >= 8 && cleanInput.includes(cleanDbKey));

            if (isExactMatch || dbContainsInput || inputContainsDb) {
                entry = dbEntry;
                keyUsed = dbKey; // Usa a key original salva no banco
                break;
            }
        }
    }

    // Se depois das 3 tentativas não achou nada, aí sim é falsa.
    if (!entry)
        return res.json({ valid: false, message: "Key falsa ou nao gerada pelo servidor!" });

    const now = Date.now();

    if (!entry.activatedAt) {
        entry.activatedAt  = now;
        entry.expiresAt    = now + entry.durationMs;
        entry.lockedUserId = userId;
        await setKey(keyUsed, entry);
    }

    if (entry.lockedUserId && entry.lockedUserId !== userId) {
        return res.json({ valid: false, message: "Essa Key ja pertence a outra conta!" });
    }

    if (!entry.expiresAt || now > entry.expiresAt)
        return res.json({ valid: false, message: "Key expirada!" });

    const remainingMs   = entry.expiresAt - now;
    const remainingDays = Math.floor(remainingMs / (1000 * 60 * 60 * 24));
    const remainingHrs  = Math.floor((remainingMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

    res.json({
        valid: true,
        message: "Key valida!",
        expiresAt: entry.expiresAt,
        remainingDays,
        remainingHrs,
    });
});

app.post("/list", async (req, res) => {
    if (req.body.password !== ADMIN_PASSWORD)
        return res.json({ success: false, error: "Senha incorreta!" });

    const db  = await getAllKeys();
    const now = Date.now();
    const lista = Object.entries(db).map(([codigo, e]) => ({
        key:        codigo,
        status:     !e.activatedAt ? "aguardando" : (now > e.expiresAt ? "expirada" : "ativa"),
        days:       e.days,
        userId:     e.lockedUserId || "-",
        expiresAt:  e.expiresAt ? new Date(e.expiresAt).toLocaleString("pt-BR") : null,
        formatName: e.formatName || "Tradicional"
    }));
    res.json({ success: true, total: lista.length, keys: lista });
});

app.post("/delete", async (req, res) => {
    const { password, key } = req.body;
    if (password !== ADMIN_PASSWORD)
        return res.json({ success: false, error: "Senha incorreta!" });

    const kInput = (key || "").trim();
    let entry = await getKey(kInput);
    let keyToDelete = kInput;

    if (!entry) {
        entry = await getKey(kInput.toUpperCase());
        if (entry) keyToDelete = kInput.toUpperCase();
    }

    if (!entry) return res.json({ success: false, error: "Key nao encontrada!" });
    
    await deleteKey(keyToDelete);
    res.json({ success: true, message: `Key deletada.` });
});

app.get("/", (req, res) => res.send("Kauan Xit Key Server online!"));

app.listen(PORT, () => {
    console.log(`Kauan Xit Key Server rodando na porta ${PORT}`);
});
